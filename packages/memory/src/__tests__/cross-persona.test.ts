import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  getAccessiblePersonas,
  createPool,
  addToPool,
  setInheritance,
} from "../cross-persona.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE persona_pools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE persona_pool_members (
      pool_id TEXT NOT NULL REFERENCES persona_pools(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      added_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (pool_id, persona)
    );
    CREATE TABLE persona_inheritance (
      child_persona TEXT PRIMARY KEY,
      parent_persona TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  return db;
}

describe("getAccessiblePersonas", () => {
  test("returns the querying persona when isolated", () => {
    const db = makeDb();
    const accessible = getAccessiblePersonas(db, "solo");
    expect(accessible).toEqual(["solo"]);
  });

  test("includes direct pool peers", () => {
    const db = makeDb();
    const pool = createPool(db, "dev-pool");
    addToPool(db, pool, "alice");
    addToPool(db, pool, "bob");
    const accessible = getAccessiblePersonas(db, "alice");
    expect(accessible.sort()).toEqual(["alice", "bob"]);
  });

  test("includes the direct inheritance parent", () => {
    // Schema stores one parent row per child (child_persona is PRIMARY KEY),
    // so additional parents are only reachable transitively via pools.
    const db = makeDb();
    setInheritance(db, "junior-dev", ["backend-architect"]);
    const accessible = getAccessiblePersonas(db, "junior-dev");
    expect(accessible.sort()).toEqual(["backend-architect", "junior-dev"]);
  });

  test("cp-12: includes transitive pool peers via inheritance chain", () => {
    // Scenario mirrors zourobench cp-12:
    //   junior-dev inherits from [backend-architect, alaric]
    //   dev-pool members: {backend-architect, alaric, security-auditor}
    // Expected accessible set:
    //   {junior-dev, backend-architect, alaric, security-auditor}
    const db = makeDb();
    const devPool = createPool(db, "dev-pool");
    addToPool(db, devPool, "backend-architect");
    addToPool(db, devPool, "alaric");
    addToPool(db, devPool, "security-auditor");
    setInheritance(db, "junior-dev", ["backend-architect", "alaric"]);

    const accessible = getAccessiblePersonas(db, "junior-dev");
    expect(accessible.sort()).toEqual([
      "alaric",
      "backend-architect",
      "junior-dev",
      "security-auditor",
    ]);
  });

  test("does not cross unrelated pools when inheriting", () => {
    // junior-dev inherits alaric (in dev-pool); financial-advisor is in finance-pool only.
    // financial-advisor must NOT become accessible.
    const db = makeDb();
    const devPool = createPool(db, "dev-pool");
    addToPool(db, devPool, "alaric");
    const financePool = createPool(db, "finance-pool");
    addToPool(db, financePool, "financial-advisor");
    setInheritance(db, "junior-dev", ["alaric"]);

    const accessible = getAccessiblePersonas(db, "junior-dev");
    expect(accessible).toContain("alaric");
    expect(accessible).toContain("junior-dev");
    expect(accessible).not.toContain("financial-advisor");
  });

  test("deduplicates when persona is both a direct peer and transitively reachable", () => {
    const db = makeDb();
    const pool = createPool(db, "dev-pool");
    addToPool(db, pool, "alice");
    addToPool(db, pool, "bob");
    addToPool(db, pool, "carol");
    setInheritance(db, "alice", ["bob"]); // bob also in alice's pool
    const accessible = getAccessiblePersonas(db, "alice");
    expect(accessible.sort()).toEqual(["alice", "bob", "carol"]);
    // Assert no duplicates
    expect(accessible.length).toBe(new Set(accessible).size);
  });
});
