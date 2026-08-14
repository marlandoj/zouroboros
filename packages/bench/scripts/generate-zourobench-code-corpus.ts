#!/usr/bin/env bun

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeTaskCategory, CodingCorpusManifest, CodingTaskManifest } from "../coding/contracts";
import { validateCodingManifest } from "../coding/contracts";

interface Definition {
  id: string;
  fold: number;
  seed: number;
  category: CodeTaskCategory;
  title: string;
  prompt: string;
  starter: string;
  solution: string;
  visibleTest: string;
  solutionTest: string;
  mutation?: string;
  hidden: string[];
}

const pkg = `${JSON.stringify({ name: "zourobench-code-task", type: "module", private: true, scripts: { test: "bun test" } }, null, 2)}\n`;
const tsconfig = `${JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true, types: ["bun"] }, include: ["src/**/*.ts", "test/**/*.ts", ".zbc-hidden/**/*.ts"] }, null, 2)}\n`;
const testFile = (body: string) => `import { describe, expect, test } from "bun:test";\nimport * as subject from "../src/index";\n\ndescribe("task", () => {\n${body}\n});\n`;
const hiddenFile = (body: string) => `import { expect, test } from "bun:test";\nimport * as subject from "../src/index";\n\n${body}\n`;

const definitions: Definition[] = [
  {
    id: "retry-after-bounds", fold: 1, seed: 1101, category: "bug-fix",
    title: "Repair Retry-After parsing",
    prompt: "Repair parseRetryAfter so it accepts seconds and HTTP dates, falls back for invalid or past values, and never exceeds maxMs. Add tests for the behavior. Do not change the exported signature.",
    starter: `export function parseRetryAfter(value: string | null, nowMs: number, fallbackMs: number, maxMs: number): number {\n  if (value === null) return fallbackMs;\n  return Number(value) * 1000;\n}\n`,
    solution: `export function parseRetryAfter(value: string | null, nowMs: number, fallbackMs: number, maxMs: number): number {\n  if (!value?.trim()) return Math.min(fallbackMs, maxMs);\n  const seconds = Number(value);\n  const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - nowMs;\n  if (!Number.isFinite(requested) || requested < 0) return Math.min(fallbackMs, maxMs);\n  return Math.min(Math.round(requested), maxMs);\n}\n`,
    visibleTest: testFile(`  test("seconds", () => expect(subject.parseRetryAfter("2", 0, 500, 10_000)).toBe(2_000));`),
    solutionTest: testFile(`  test("seconds, fallback, and cap", () => {\n    expect(subject.parseRetryAfter("2", 0, 500, 10_000)).toBe(2_000);\n    expect(subject.parseRetryAfter(null, 0, 500, 10_000)).toBe(500);\n    expect(subject.parseRetryAfter("99", 0, 500, 4_000)).toBe(4_000);\n  });`),
    hidden: [
      hiddenFile(`test("HTTP date", () => expect(subject.parseRetryAfter("Thu, 01 Jan 1970 00:00:03 GMT", 1_000, 500, 10_000)).toBe(2_000));`),
      hiddenFile(`test("invalid and past fallback", () => { expect(subject.parseRetryAfter("bad", 0, 750, 10_000)).toBe(750); expect(subject.parseRetryAfter("Thu, 01 Jan 1970 00:00:00 GMT", 1_000, 750, 10_000)).toBe(750); });`),
      hiddenFile(`test("cap", () => expect(subject.parseRetryAfter("99", 0, 500, 4_000)).toBe(4_000));`),
    ],
  },
  {
    id: "ttl-cache", fold: 1, seed: 1102, category: "feature",
    title: "Implement a bounded TTL cache",
    prompt: "Implement TtlCache with get, set, delete, and size. Expired entries must disappear on access, capacity eviction must remove the least recently used entry, and now() must remain injectable. Add tests.",
    starter: `export class TtlCache<K, V> {\n  constructor(_capacity: number, _ttlMs: number, _now: () => number = Date.now) {}\n  get(_key: K): V | undefined { return undefined; }\n  set(_key: K, _value: V): void {}\n  delete(_key: K): boolean { return false; }\n  get size(): number { return 0; }\n}\n`,
    solution: `export class TtlCache<K, V> {\n  private readonly entries = new Map<K, { value: V; expiresAt: number }>();\n  constructor(private readonly capacity: number, private readonly ttlMs: number, private readonly now: () => number = Date.now) {\n    if (!Number.isInteger(capacity) || capacity < 1 || ttlMs < 0) throw new Error("invalid cache bounds");\n  }\n  private purge(): void { for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(key); }\n  get(key: K): V | undefined {\n    this.purge(); const entry = this.entries.get(key); if (!entry) return undefined;\n    this.entries.delete(key); this.entries.set(key, entry); return entry.value;\n  }\n  set(key: K, value: V): void {\n    this.purge(); this.entries.delete(key);\n    while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value as K);\n    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });\n  }\n  delete(key: K): boolean { return this.entries.delete(key); }\n  get size(): number { this.purge(); return this.entries.size; }\n}\n`,
    visibleTest: testFile(`  test("stores a value", () => { const cache = new subject.TtlCache<string, number>(2, 100, () => 0); cache.set("a", 1); expect(cache.get("a")).toBe(1); });`),
    solutionTest: testFile(`  test("stores and expires", () => { let now = 0; const cache = new subject.TtlCache<string, number>(2, 10, () => now); cache.set("a", 1); expect(cache.get("a")).toBe(1); now = 10; expect(cache.get("a")).toBeUndefined(); });`),
    hidden: [
      hiddenFile(`test("LRU eviction", () => { const cache = new subject.TtlCache<string, number>(2, 100, () => 0); cache.set("a", 1); cache.set("b", 2); cache.get("a"); cache.set("c", 3); expect(cache.get("b")).toBeUndefined(); expect(cache.get("a")).toBe(1); });`),
      hiddenFile(`test("overwrite does not inflate size", () => { const cache = new subject.TtlCache<string, number>(2, 100, () => 0); cache.set("a", 1); cache.set("a", 2); expect(cache.size).toBe(1); expect(cache.get("a")).toBe(2); });`),
      hiddenFile(`test("delete and invalid capacity", () => { const cache = new subject.TtlCache<string, number>(1, 1, () => 0); cache.set("a", 1); expect(cache.delete("a")).toBeTrue(); expect(cache.size).toBe(0); expect(() => new subject.TtlCache(0, 1)).toThrow(); });`),
    ],
  },
  {
    id: "provider-config-merge", fold: 1, seed: 1103, category: "integration",
    title: "Merge provider configuration safely",
    prompt: "Implement mergeProviderConfig. Preserve untouched providers and nested options, replace arrays instead of concatenating them, reject prototype-pollution keys, and never mutate either input. Add tests.",
    starter: `export type Config = Record<string, unknown>;\nexport function mergeProviderConfig(base: Config, override: Config): Config { return { ...base, ...override }; }\n`,
    solution: `export type Config = Record<string, unknown>;\nconst blocked = new Set(["__proto__", "prototype", "constructor"]);\nfunction plain(value: unknown): value is Config { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }\nexport function mergeProviderConfig(base: Config, override: Config): Config {\n  const out: Config = {};\n  for (const source of [base, override]) {\n    for (const [key, value] of Object.entries(source)) {\n      if (blocked.has(key)) throw new Error("unsafe configuration key");\n      out[key] = plain(value) && plain(out[key]) ? mergeProviderConfig(out[key] as Config, value) : structuredClone(value);\n    }\n  }\n  return out;\n}\n`,
    visibleTest: testFile(`  test("top-level merge", () => expect(subject.mergeProviderConfig({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 }));`),
    solutionTest: testFile(`  test("nested merge", () => expect(subject.mergeProviderConfig({ p: { url: "a", headers: { x: 1 } } }, { p: { headers: { y: 2 } } })).toEqual({ p: { url: "a", headers: { x: 1, y: 2 } } }));`),
    hidden: [
      hiddenFile(`test("arrays replace", () => expect(subject.mergeProviderConfig({ models: ["a"] }, { models: ["b"] })).toEqual({ models: ["b"] }));`),
      hiddenFile(`test("inputs are immutable", () => { const base = { p: { x: 1 } }; const over = { p: { y: 2 } }; const result = subject.mergeProviderConfig(base, over) as any; result.p.x = 9; expect(base.p.x).toBe(1); expect(over.p.y).toBe(2); });`),
      hiddenFile(`test("pollution blocked", () => { const bad = JSON.parse('{"__proto__":{"polluted":true}}'); expect(() => subject.mergeProviderConfig({}, bad)).toThrow(); });`),
    ],
  },
  {
    id: "typed-result-refactor", fold: 1, seed: 1104, category: "refactor",
    title: "Refactor parsing into a typed result",
    prompt: "Refactor parsePort to return the exported discriminated ParseResult union without throwing. Accept integer ports 1 through 65535, preserve the public names, and add tests. Do not use any or type assertions.",
    starter: `export interface ParseResult { ok: boolean; value?: number; error?: string }\nexport function parsePort(raw: string): ParseResult { const value = Number(raw); if (!value) throw new Error("invalid"); return { ok: true, value }; }\n`,
    solution: `export type ParseResult = { ok: true; value: number } | { ok: false; error: string };\nexport function parsePort(raw: string): ParseResult {\n  if (!/^\\d+$/.test(raw.trim())) return { ok: false, error: "port must be an integer" };\n  const value = Number(raw);\n  if (!Number.isInteger(value) || value < 1 || value > 65_535) return { ok: false, error: "port outside 1..65535" };\n  return { ok: true, value };\n}\n`,
    visibleTest: testFile(`  test("valid", () => expect(subject.parsePort("8080")).toEqual({ ok: true, value: 8080 }));`),
    solutionTest: testFile(`  test("valid and invalid", () => { expect(subject.parsePort("8080")).toEqual({ ok: true, value: 8080 }); expect(subject.parsePort("x").ok).toBeFalse(); });`),
    hidden: [
      hiddenFile(`test("bounds", () => { expect(subject.parsePort("1")).toEqual({ ok: true, value: 1 }); expect(subject.parsePort("65535")).toEqual({ ok: true, value: 65535 }); });`),
      hiddenFile(`test("rejects malformed", () => { for (const value of ["0", "65536", "1.5", "", "12x"]) expect(subject.parsePort(value).ok).toBeFalse(); });`),
      hiddenFile(`test("never throws", () => expect(() => subject.parsePort("not-a-port")).not.toThrow());`),
    ],
  },
  {
    id: "stable-dedupe", fold: 2, seed: 1201, category: "bug-fix",
    title: "Repair stable record deduplication",
    prompt: "Fix dedupeById to retain the first record for each non-empty id in original order. Empty ids must be rejected and the input must not be mutated. Add tests.",
    starter: `export interface RecordItem { id: string; value: number }\nexport function dedupeById(items: RecordItem[]): RecordItem[] { return [...new Map(items.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id)); }\n`,
    solution: `export interface RecordItem { id: string; value: number }\nexport function dedupeById(items: RecordItem[]): RecordItem[] { const seen = new Set<string>(); const out: RecordItem[] = []; for (const item of items) { if (!item.id.trim()) throw new Error("id required"); if (!seen.has(item.id)) { seen.add(item.id); out.push({ ...item }); } } return out; }\n`,
    visibleTest: testFile(`  test("dedupes", () => expect(subject.dedupeById([{ id: "a", value: 1 }, { id: "a", value: 2 }])).toEqual([{ id: "a", value: 1 }]));`),
    solutionTest: testFile(`  test("first and stable", () => expect(subject.dedupeById([{ id: "b", value: 1 }, { id: "a", value: 2 }, { id: "b", value: 3 }])).toEqual([{ id: "b", value: 1 }, { id: "a", value: 2 }]));`),
    hidden: [
      hiddenFile(`test("order", () => expect(subject.dedupeById([{id:"z",value:1},{id:"a",value:2}]).map(x=>x.id)).toEqual(["z","a"]));`),
      hiddenFile(`test("reject empty", () => expect(() => subject.dedupeById([{id:" ",value:1}])).toThrow());`),
      hiddenFile(`test("copies and preserves input", () => { const input=[{id:"a",value:1}]; const out=subject.dedupeById(input); out[0]!.value=9; expect(input[0]!.value).toBe(1); });`),
    ],
  },
  {
    id: "concurrency-limiter", fold: 2, seed: 1202, category: "feature",
    title: "Implement bounded async mapping",
    prompt: "Implement mapConcurrent so results preserve input order, active work never exceeds limit, rejection stops scheduling new work after already-active work settles, and invalid limits fail before invoking the mapper. Add tests.",
    starter: `export async function mapConcurrent<T, R>(_items: T[], _limit: number, _mapper: (item: T, index: number) => Promise<R>): Promise<R[]> { return []; }\n`,
    solution: `export async function mapConcurrent<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {\n  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be positive");\n  const results = new Array<R>(items.length); let cursor = 0; let failure: unknown;\n  async function worker(): Promise<void> { while (failure === undefined) { const index = cursor++; if (index >= items.length) return; try { results[index] = await mapper(items[index]!, index); } catch (error) { failure = error; return; } } }\n  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));\n  if (failure !== undefined) throw failure; return results;\n}\n`,
    visibleTest: testFile(`  test("maps", async () => expect(await subject.mapConcurrent([1,2], 1, async x => x * 2)).toEqual([2,4]));`),
    solutionTest: testFile(`  test("order", async () => expect(await subject.mapConcurrent([1,2,3], 2, async x => { await Bun.sleep(4-x); return x; })).toEqual([1,2,3]));`),
    hidden: [
      hiddenFile(`test("bound", async () => { let active=0,max=0; await subject.mapConcurrent([1,2,3,4],2,async x=>{active++;max=Math.max(max,active);await Bun.sleep(5);active--;return x}); expect(max).toBe(2); });`),
      hiddenFile(`test("invalid limit", async () => { let calls=0; await expect(subject.mapConcurrent([1],0,async x=>{calls++;return x})).rejects.toThrow(); expect(calls).toBe(0); });`),
      hiddenFile(`test("rejects", async () => await expect(subject.mapConcurrent([1,2,3],1,async x=>{if(x===2) throw new Error("stop"); return x})).rejects.toThrow("stop"));`),
    ],
  },
  {
    id: "provider-fallback", fold: 2, seed: 1203, category: "integration",
    title: "Select a provider-diverse fallback",
    prompt: "Implement selectFallback. Prefer candidates in declared order, require healthy status, exclude the failed route, prefer a different provider and family, then relax family before provider. Return null when none qualify. Add tests.",
    starter: `export interface Candidate { id:string; provider:string; family:string; health:"healthy"|"held" }\nexport function selectFallback(_failed:Candidate,_candidates:Candidate[]):Candidate|null { return null; }\n`,
    solution: `export interface Candidate { id:string; provider:string; family:string; health:"healthy"|"held" }\nexport function selectFallback(failed:Candidate,candidates:Candidate[]):Candidate|null { const eligible=candidates.filter(c=>c.id!==failed.id&&c.health==="healthy"); return eligible.find(c=>c.provider!==failed.provider&&c.family!==failed.family) ?? eligible.find(c=>c.provider!==failed.provider) ?? eligible.find(c=>c.family!==failed.family) ?? eligible[0] ?? null; }\n`,
    visibleTest: testFile(`  test("healthy", () => { const failed={id:"a",provider:"p1",family:"f1",health:"healthy" as const}; expect(subject.selectFallback(failed,[failed,{id:"b",provider:"p2",family:"f2",health:"healthy"}])?.id).toBe("b"); });`),
    solutionTest: testFile(`  test("diverse first", () => { const f={id:"a",provider:"p1",family:"f1",health:"healthy" as const}; const c=[{id:"b",provider:"p1",family:"f2",health:"healthy" as const},{id:"c",provider:"p2",family:"f2",health:"healthy" as const}]; expect(subject.selectFallback(f,c)?.id).toBe("c"); });`),
    hidden: [
      hiddenFile(`test("skips held",()=>{const f={id:"a",provider:"p1",family:"f1",health:"healthy" as const};expect(subject.selectFallback(f,[{id:"x",provider:"p2",family:"f2",health:"held"}])).toBeNull()});`),
      hiddenFile(`test("relaxes family",()=>{const f={id:"a",provider:"p1",family:"f1",health:"healthy" as const};expect(subject.selectFallback(f,[{id:"x",provider:"p2",family:"f1",health:"healthy"}])?.id).toBe("x")});`),
      hiddenFile(`test("order within tier",()=>{const f={id:"a",provider:"p1",family:"f1",health:"healthy" as const};const c=[{id:"x",provider:"p2",family:"f2",health:"healthy" as const},{id:"y",provider:"p3",family:"f3",health:"healthy" as const}];expect(subject.selectFallback(f,c)?.id).toBe("x")});`),
    ],
  },
  {
    id: "retry-policy-tests", fold: 2, seed: 1204, category: "test-creation",
    title: "Add adversarial retry-policy tests",
    prompt: "Add tests for retryDelayMs. Cover Retry-After seconds, HTTP dates, caps, invalid values, and non-retriable statuses. Do not change src/index.ts.",
    starter: `export function retryDelayMs(status:number,retryAfter:string|null,now:number,cap=60_000):number|null { if (![429,500,502,503,504].includes(status)) return null; if (!retryAfter) return Math.min(status===429?60_000:1_000,cap); const seconds=Number(retryAfter); const delay=Number.isFinite(seconds)?seconds*1000:Date.parse(retryAfter)-now; return Math.min(Math.max(0,Number.isFinite(delay)?delay:1_000),cap); }\n`,
    solution: `export function retryDelayMs(status:number,retryAfter:string|null,now:number,cap=60_000):number|null { if (![429,500,502,503,504].includes(status)) return null; if (!retryAfter) return Math.min(status===429?60_000:1_000,cap); const seconds=Number(retryAfter); const delay=Number.isFinite(seconds)?seconds*1000:Date.parse(retryAfter)-now; return Math.min(Math.max(0,Number.isFinite(delay)?delay:1_000),cap); }\n`,
    visibleTest: testFile(`  test("placeholder", () => expect(true).toBeTrue());`),
    solutionTest: testFile(`  test("seconds dates caps and status",()=>{expect(subject.retryDelayMs(429,"2",0)).toBe(2000);expect(subject.retryDelayMs(429,"Thu, 01 Jan 1970 00:00:03 GMT",1000)).toBe(2000);expect(subject.retryDelayMs(429,"99",0,4000)).toBe(4000);expect(subject.retryDelayMs(400,null,0)).toBeNull()});`),
    mutation: `export function retryDelayMs(status:number,retryAfter:string|null,_now:number,_cap=60_000):number|null { if (status!==429) return null; return retryAfter?Number(retryAfter)*1000:60_000; }\n`,
    hidden: [
      hiddenFile(`test("source unchanged",()=>expect(subject.retryDelayMs(503,null,0)).toBe(1000));`),
      hiddenFile(`test("date",()=>expect(subject.retryDelayMs(429,"Thu, 01 Jan 1970 00:00:03 GMT",1000)).toBe(2000));`),
      hiddenFile(`test("cap and status",()=>{expect(subject.retryDelayMs(429,"99",0,4000)).toBe(4000);expect(subject.retryDelayMs(401,null,0)).toBeNull()});`),
    ],
  },
  {
    id: "safe-path-join", fold: 3, seed: 1301, category: "bug-fix",
    title: "Repair path traversal protection",
    prompt: "Fix safeJoin so it returns a resolved path strictly inside root, rejects absolute paths, traversal, sibling-prefix escapes, and the root itself, and handles platform separators. Add tests.",
    starter: `import { resolve } from "node:path";\nexport function safeJoin(root:string,input:string):string { const path=resolve(root,input); if(!path.startsWith(resolve(root))) throw new Error("escape"); return path; }\n`,
    solution: `import { isAbsolute, relative, resolve, sep } from "node:path";\nexport function safeJoin(root:string,input:string):string { if(isAbsolute(input)) throw new Error("absolute path rejected"); const base=resolve(root); const path=resolve(base,input); const rel=relative(base,path); if(!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel)) throw new Error("path escapes root"); return path; }\n`,
    visibleTest: testFile(`  test("child",()=>expect(subject.safeJoin("/tmp/root","a.json")).toBe("/tmp/root/a.json"));`),
    solutionTest: testFile(`  test("child, traversal, and sibling escape",()=>{expect(subject.safeJoin("/tmp/root","a.json")).toBe("/tmp/root/a.json");expect(()=>subject.safeJoin("/tmp/root","../x")).toThrow();expect(()=>subject.safeJoin("/tmp/root","../root2/x")).toThrow()});`),
    hidden: [
      hiddenFile(`test("sibling prefix",()=>expect(()=>subject.safeJoin("/tmp/root","../root2/x")).toThrow());`),
      hiddenFile(`test("absolute",()=>expect(()=>subject.safeJoin("/tmp/root","/etc/passwd")).toThrow());`),
      hiddenFile(`test("root itself",()=>expect(()=>subject.safeJoin("/tmp/root",".")).toThrow());`),
    ],
  },
  {
    id: "topological-layers", fold: 3, seed: 1302, category: "feature",
    title: "Implement deterministic DAG layers",
    prompt: "Implement topologicalLayers. Return deterministic alphabetically sorted execution layers, reject missing dependencies, duplicate ids, and cycles, and do not mutate input. Add tests.",
    starter: `export interface Node { id:string; dependsOn:string[] }\nexport function topologicalLayers(_nodes:Node[]):string[][] { return []; }\n`,
    solution: `export interface Node { id:string; dependsOn:string[] }\nexport function topologicalLayers(nodes:Node[]):string[][] { const ids=new Set<string>(); for(const n of nodes){if(ids.has(n.id))throw new Error("duplicate id");ids.add(n.id)} for(const n of nodes)for(const d of n.dependsOn)if(!ids.has(d))throw new Error("missing dependency"); const remaining=new Map(nodes.map(n=>[n.id,new Set(n.dependsOn)])); const layers:string[][]=[]; while(remaining.size){const ready=[...remaining].filter(([,d])=>d.size===0).map(([id])=>id).sort();if(!ready.length)throw new Error("cycle");layers.push(ready);for(const id of ready)remaining.delete(id);for(const deps of remaining.values())for(const id of ready)deps.delete(id)} return layers; }\n`,
    visibleTest: testFile(`  test("layers",()=>expect(subject.topologicalLayers([{id:"a",dependsOn:[]},{id:"b",dependsOn:["a"]}])).toEqual([["a"],["b"]]));`),
    solutionTest: testFile(`  test("parallel deterministic",()=>expect(subject.topologicalLayers([{id:"b",dependsOn:[]},{id:"a",dependsOn:[]},{id:"c",dependsOn:["a","b"]}])).toEqual([["a","b"],["c"]]));`),
    hidden: [
      hiddenFile(`test("cycle",()=>expect(()=>subject.topologicalLayers([{id:"a",dependsOn:["b"]},{id:"b",dependsOn:["a"]}])).toThrow());`),
      hiddenFile(`test("missing",()=>expect(()=>subject.topologicalLayers([{id:"a",dependsOn:["x"]}])).toThrow());`),
      hiddenFile(`test("duplicate and immutable",()=>{expect(()=>subject.topologicalLayers([{id:"a",dependsOn:[]},{id:"a",dependsOn:[]}])).toThrow();const n=[{id:"a",dependsOn:[]}];subject.topologicalLayers(n);expect(n).toEqual([{id:"a",dependsOn:[]}])});`),
    ],
  },
  {
    id: "event-reducer", fold: 3, seed: 1303, category: "integration",
    title: "Integrate idempotent event reduction",
    prompt: "Implement reduceEvents. Deduplicate by event id, process timestamp then id order, reject impossible transitions, and return immutable state with a deterministic appliedIds ledger. Add tests.",
    starter: `export type Status="queued"|"running"|"done"|"failed"; export interface Event{id:string;at:number;to:Status} export interface State{status:Status;appliedIds:string[]} export function reduceEvents(state:State,_events:Event[]):State{return state}\n`,
    solution: `export type Status="queued"|"running"|"done"|"failed"; export interface Event{id:string;at:number;to:Status} export interface State{status:Status;appliedIds:string[]} const allowed:Record<Status,Status[]>={queued:["running"],running:["done","failed"],done:[],failed:[]}; export function reduceEvents(state:State,events:Event[]):State{let status=state.status;const seen=new Set(state.appliedIds);const applied=[...state.appliedIds];for(const event of [...events].sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))){if(seen.has(event.id))continue;if(!allowed[status].includes(event.to))throw new Error("invalid transition "+status+"->"+event.to);seen.add(event.id);applied.push(event.id);status=event.to}return{status,appliedIds:applied}}\n`,
    visibleTest: testFile(`  test("reduces",()=>expect(subject.reduceEvents({status:"queued",appliedIds:[]},[{id:"1",at:1,to:"running"}])).toEqual({status:"running",appliedIds:["1"]}));`),
    solutionTest: testFile(`  test("orders",()=>expect(subject.reduceEvents({status:"queued",appliedIds:[]},[{id:"b",at:2,to:"done"},{id:"a",at:1,to:"running"}]).status).toBe("done"));`),
    hidden: [
      hiddenFile(`test("idempotent",()=>expect(subject.reduceEvents({status:"running",appliedIds:["a"]},[{id:"a",at:1,to:"running"},{id:"b",at:2,to:"done"}])).toEqual({status:"done",appliedIds:["a","b"]}));`),
      hiddenFile(`test("invalid",()=>expect(()=>subject.reduceEvents({status:"queued",appliedIds:[]},[{id:"x",at:1,to:"done"}])).toThrow());`),
      hiddenFile(`test("immutable",()=>{const s={status:"queued" as const,appliedIds:[] as string[]};const e=[{id:"a",at:1,to:"running" as const}];subject.reduceEvents(s,e);expect(s.appliedIds).toEqual([]);expect(e).toEqual([{id:"a",at:1,to:"running"}])});`),
    ],
  },
  {
    id: "deterministic-sort", fold: 3, seed: 1304, category: "refactor",
    title: "Refactor candidate sorting deterministically",
    prompt: "Refactor rankCandidates into a pure deterministic sort: measured candidates first, selection floor descending, provider rank ascending, cost ascending, then id. Null floors must not be treated as zero. Do not mutate input. Add tests.",
    starter: `export interface Candidate{id:string;floor:number|null;providerRank:number;cost:number} export function rankCandidates(items:Candidate[]):Candidate[]{return items.sort((a,b)=>(b.floor??0)-(a.floor??0))}\n`,
    solution: `export interface Candidate{id:string;floor:number|null;providerRank:number;cost:number} export function rankCandidates(items:Candidate[]):Candidate[]{return [...items].sort((a,b)=>Number(b.floor!==null)-Number(a.floor!==null)||(b.floor??0)-(a.floor??0)||a.providerRank-b.providerRank||a.cost-b.cost||a.id.localeCompare(b.id))}\n`,
    visibleTest: testFile(`  test("floor",()=>expect(subject.rankCandidates([{id:"a",floor:1,providerRank:1,cost:1},{id:"b",floor:2,providerRank:1,cost:1}]).map(x=>x.id)).toEqual(["b","a"]));`),
    solutionTest: testFile(`  test("measured",()=>expect(subject.rankCandidates([{id:"u",floor:null,providerRank:0,cost:0},{id:"m",floor:0,providerRank:9,cost:9}]).map(x=>x.id)).toEqual(["m","u"]));`),
    hidden: [
      hiddenFile(`test("provider and cost",()=>expect(subject.rankCandidates([{id:"b",floor:1,providerRank:2,cost:0},{id:"a",floor:1,providerRank:1,cost:9},{id:"c",floor:1,providerRank:1,cost:1}]).map(x=>x.id)).toEqual(["c","a","b"]));`),
      hiddenFile(`test("id tie",()=>expect(subject.rankCandidates([{id:"z",floor:null,providerRank:1,cost:1},{id:"a",floor:null,providerRank:1,cost:1}]).map(x=>x.id)).toEqual(["a","z"]));`),
      hiddenFile(`test("immutable",()=>{const x=[{id:"b",floor:1,providerRank:1,cost:1},{id:"a",floor:1,providerRank:1,cost:1}];subject.rankCandidates(x);expect(x.map(v=>v.id)).toEqual(["b","a"])});`),
    ],
  },
  {
    id: "terminal-state-machine", fold: 4, seed: 1401, category: "bug-fix",
    title: "Repair terminal lifecycle transitions",
    prompt: "Fix transition so only queued->running, running->done, and running->failed are accepted. Repeating the current state is idempotent, terminal states cannot move, and unknown states fail closed. Add tests.",
    starter: `export type State="queued"|"running"|"done"|"failed"; export function transition(_from:State,to:State):State{return to}\n`,
    solution: `export type State="queued"|"running"|"done"|"failed"; const allowed:Record<State,State[]>={queued:["running"],running:["done","failed"],done:[],failed:[]}; export function transition(from:State,to:State):State{if(from===to)return from;if(!allowed[from]?.includes(to))throw new Error("invalid transition "+from+"->"+to);return to}\n`,
    visibleTest: testFile(`  test("starts",()=>expect(subject.transition("queued","running")).toBe("running"));`),
    solutionTest: testFile(`  test("terminal",()=>{expect(subject.transition("running","done")).toBe("done");expect(()=>subject.transition("done","running")).toThrow()});`),
    hidden: [
      hiddenFile(`test("idempotent",()=>expect(subject.transition("failed","failed")).toBe("failed"));`),
      hiddenFile(`test("queued cannot finish",()=>expect(()=>subject.transition("queued","done")).toThrow());`),
      hiddenFile(`test("terminal closed",()=>{expect(()=>subject.transition("done","failed")).toThrow();expect(()=>subject.transition("failed","running")).toThrow()});`),
    ],
  },
  {
    id: "cursor-pagination", fold: 4, seed: 1402, category: "feature",
    title: "Implement stable cursor pagination",
    prompt: "Implement paginate. Sort by createdAt descending then id ascending, use an opaque base64url cursor containing both keys, reject malformed or missing cursors, and return hasNextPage plus endCursor. Do not mutate items. Add tests.",
    starter: `export interface Item{id:string;createdAt:string} export interface Page{items:Item[];endCursor:string|null;hasNextPage:boolean} export function paginate(_items:Item[],_limit:number,_after?:string):Page{return{items:[],endCursor:null,hasNextPage:false}}\n`,
    solution: `export interface Item{id:string;createdAt:string} export interface Page{items:Item[];endCursor:string|null;hasNextPage:boolean} const encode=(x:Item)=>Buffer.from(JSON.stringify([x.createdAt,x.id])).toString("base64url"); const decode=(x:string):[string,string]=>{try{const v=JSON.parse(Buffer.from(x,"base64url").toString());if(!Array.isArray(v)||v.length!==2||v.some(y=>typeof y!=="string"))throw 0;return v as [string,string]}catch{throw new Error("invalid cursor")}}; export function paginate(items:Item[],limit:number,after?:string):Page{if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("invalid limit");const sorted=[...items].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));let start=0;if(after){const [at,id]=decode(after);const index=sorted.findIndex(x=>x.createdAt===at&&x.id===id);if(index<0)throw new Error("cursor not found");start=index+1}const page=sorted.slice(start,start+limit);return{items:page,endCursor:page.length?encode(page.at(-1)!):null,hasNextPage:start+page.length<sorted.length}}\n`,
    visibleTest: testFile(`  test("first page",()=>expect(subject.paginate([{id:"a",createdAt:"2026-01-01"}],1).items.map(x=>x.id)).toEqual(["a"]));`),
    solutionTest: testFile(`  test("cursor",()=>{const x=[{id:"a",createdAt:"2026-01-02"},{id:"b",createdAt:"2026-01-01"}];const p=subject.paginate(x,1);expect(subject.paginate(x,1,p.endCursor!).items[0]!.id).toBe("b")});`),
    hidden: [
      hiddenFile(`test("ties",()=>expect(subject.paginate([{id:"b",createdAt:"x"},{id:"a",createdAt:"x"}],2).items.map(x=>x.id)).toEqual(["a","b"]));`),
      hiddenFile(`test("malformed and missing",()=>{expect(()=>subject.paginate([],1,"bad")).toThrow();const c=Buffer.from(JSON.stringify(["x","z"])).toString("base64url");expect(()=>subject.paginate([],1,c)).toThrow()});`),
      hiddenFile(`test("bounds and immutable",()=>{const x=[{id:"b",createdAt:"1"},{id:"a",createdAt:"2"}];expect(()=>subject.paginate(x,0)).toThrow();subject.paginate(x,1);expect(x[0]!.id).toBe("b")});`),
    ],
  },
  {
    id: "artifact-aggregation", fold: 4, seed: 1403, category: "integration",
    title: "Aggregate comparable benchmark artifacts",
    prompt: "Implement aggregateRuns. Deduplicate run ids by newest timestamp, require one context fingerprint, require unique replicate indexes and seeds, enforce minimumN, and return mean plus sample standard deviation. Add tests.",
    starter: `export interface Run{id:string;timestamp:string;context:string;index:number;seed:number;minimumN:number;score:number} export function aggregateRuns(_runs:Run[]){return null}\n`,
    solution: `export interface Run{id:string;timestamp:string;context:string;index:number;seed:number;minimumN:number;score:number} export function aggregateRuns(runs:Run[]){const byId=new Map<string,Run>();for(const run of runs){const prior=byId.get(run.id);if(!prior||Date.parse(run.timestamp)>Date.parse(prior.timestamp))byId.set(run.id,run)}const values=[...byId.values()];if(!values.length)throw new Error("empty cohort");if(new Set(values.map(x=>x.context)).size!==1)throw new Error("incomparable context");if(new Set(values.map(x=>x.index)).size!==values.length||new Set(values.map(x=>x.seed)).size!==values.length)throw new Error("duplicate replicate");const minimumN=Math.max(...values.map(x=>x.minimumN));if(values.length<minimumN)throw new Error("underpowered");const mean=values.reduce((s,x)=>s+x.score,0)/values.length;const variance=values.length>1?values.reduce((s,x)=>s+(x.score-mean)**2,0)/(values.length-1):0;return{mean,standardDeviation:Math.sqrt(variance),n:values.length}}\n`,
    visibleTest: testFile(`  test("mean",()=>expect(subject.aggregateRuns([{id:"a",timestamp:"2026-01-01",context:"x",index:1,seed:1,minimumN:1,score:80}])).toEqual({mean:80,standardDeviation:0,n:1}));`),
    solutionTest: testFile(`  test("sample spread",()=>expect(subject.aggregateRuns([{id:"a",timestamp:"2026-01-01",context:"x",index:1,seed:1,minimumN:2,score:80},{id:"b",timestamp:"2026-01-01",context:"x",index:2,seed:2,minimumN:2,score:100}]).standardDeviation).toBeCloseTo(14.1421,3));`),
    hidden: [
      hiddenFile(`test("underpowered",()=>expect(()=>subject.aggregateRuns([{id:"a",timestamp:"2026-01-01",context:"x",index:1,seed:1,minimumN:2,score:80}])).toThrow());`),
      hiddenFile(`test("context and replicate uniqueness",()=>{const a={id:"a",timestamp:"2026-01-01",context:"x",index:1,seed:1,minimumN:2,score:80};expect(()=>subject.aggregateRuns([a,{...a,id:"b",context:"y",index:2,seed:2}])).toThrow();expect(()=>subject.aggregateRuns([a,{...a,id:"b"}])).toThrow()});`),
      hiddenFile(`test("newest duplicate id",()=>{const x=[{id:"a",timestamp:"2026-01-01",context:"x",index:1,seed:1,minimumN:1,score:1},{id:"a",timestamp:"2026-01-02",context:"x",index:1,seed:1,minimumN:1,score:9}];expect(subject.aggregateRuns(x).mean).toBe(9)});`),
    ],
  },
  {
    id: "parser-edge-tests", fold: 4, seed: 1404, category: "test-creation",
    title: "Add parser boundary tests",
    prompt: "Add tests for parseModelRoute. Cover supported prefixes, whitespace, missing model ids, unknown prefixes, and embedded separators. Do not change src/index.ts.",
    starter: `export function parseModelRoute(value:string):{provider:string;model:string}{const trimmed=value.trim();const index=trimmed.indexOf(":");if(index<1||index===trimmed.length-1)throw new Error("invalid route");const provider=trimmed.slice(0,index);const model=trimmed.slice(index+1);if(!["byok","hf","oc","or","kimi"].includes(provider))throw new Error("unknown provider");if(!model.trim())throw new Error("model required");return{provider,model}}\n`,
    solution: `export function parseModelRoute(value:string):{provider:string;model:string}{const trimmed=value.trim();const index=trimmed.indexOf(":");if(index<1||index===trimmed.length-1)throw new Error("invalid route");const provider=trimmed.slice(0,index);const model=trimmed.slice(index+1);if(!["byok","hf","oc","or","kimi"].includes(provider))throw new Error("unknown provider");if(!model.trim())throw new Error("model required");return{provider,model}}\n`,
    visibleTest: testFile(`  test("placeholder",()=>expect(true).toBeTrue());`),
    solutionTest: testFile(`  test("routes and boundaries",()=>{expect(subject.parseModelRoute(" or:vendor/model ")).toEqual({provider:"or",model:"vendor/model"});expect(()=>subject.parseModelRoute("bad")).toThrow();expect(()=>subject.parseModelRoute("x:y")).toThrow();expect(subject.parseModelRoute("or:a:b").model).toBe("a:b")});`),
    mutation: `export function parseModelRoute(value:string):{provider:string;model:string}{const [provider,model]=value.split(":");return{provider,model}}\n`,
    hidden: [
      hiddenFile(`test("source behavior",()=>expect(subject.parseModelRoute("or:a:b")).toEqual({provider:"or",model:"a:b"}));`),
      hiddenFile(`test("unknown",()=>expect(()=>subject.parseModelRoute("unknown:model")).toThrow());`),
      hiddenFile(`test("missing",()=>{expect(()=>subject.parseModelRoute("or:")).toThrow();expect(()=>subject.parseModelRoute(":x")).toThrow()});`),
    ],
  },
  {
    id: "retry-budget", fold: 5, seed: 1501, category: "bug-fix",
    title: "Repair retry budget accounting",
    prompt: "Fix consumeRetry so each error class has an independent non-negative budget, success resets only the selected class, exhausted attempts fail closed, and input state is not mutated. Add tests.",
    starter: `export type Kind="rate"|"transport"|"parse"; export type Budget=Record<Kind,number>; export function consumeRetry(state:Budget,kind:Kind,success=false):Budget{if(success)return{rate:0,transport:0,parse:0};state[kind]--;return state}\n`,
    solution: `export type Kind="rate"|"transport"|"parse"; export type Budget=Record<Kind,number>; export function consumeRetry(state:Budget,kind:Kind,success=false):Budget{const next={...state};if(success){next[kind]=0;return next}if(next[kind]<=0)throw new Error("retry budget exhausted: "+kind);next[kind]-=1;return next}\n`,
    visibleTest: testFile(`  test("consumes",()=>expect(subject.consumeRetry({rate:2,transport:1,parse:1},"rate").rate).toBe(1));`),
    solutionTest: testFile(`  test("independent immutable",()=>{const x={rate:2,transport:1,parse:1};expect(subject.consumeRetry(x,"rate")).toEqual({rate:1,transport:1,parse:1});expect(x.rate).toBe(2)});`),
    hidden: [
      hiddenFile(`test("exhausted",()=>expect(()=>subject.consumeRetry({rate:0,transport:1,parse:1},"rate")).toThrow());`),
      hiddenFile(`test("success resets selected",()=>expect(subject.consumeRetry({rate:2,transport:1,parse:1},"transport",true)).toEqual({rate:2,transport:0,parse:1}));`),
      hiddenFile(`test("does not go negative",()=>{const x={rate:0,transport:0,parse:0};expect(()=>subject.consumeRetry(x,"parse")).toThrow();expect(x.parse).toBe(0)});`),
    ],
  },
  {
    id: "sliding-rate-limit", fold: 5, seed: 1502, category: "feature",
    title: "Implement a sliding-window limiter",
    prompt: "Implement SlidingWindowLimiter.allow. Keep at most limit accepted timestamps in the inclusive window, prune old entries, reject non-monotonic clocks, and expose immutable snapshot(). Add tests.",
    starter: `export class SlidingWindowLimiter{constructor(_limit:number,_windowMs:number){}allow(_now:number):boolean{return true}snapshot():number[]{return[]}}\n`,
    solution: `export class SlidingWindowLimiter{private accepted:number[]=[];private last=Number.NEGATIVE_INFINITY;constructor(private readonly limit:number,private readonly windowMs:number){if(!Number.isInteger(limit)||limit<1||windowMs<1)throw new Error("invalid bounds")}allow(now:number):boolean{if(now<this.last)throw new Error("clock moved backwards");this.last=now;this.accepted=this.accepted.filter(at=>now-at<this.windowMs);if(this.accepted.length>=this.limit)return false;this.accepted.push(now);return true}snapshot():number[]{return[...this.accepted]}}\n`,
    visibleTest: testFile(`  test("limits",()=>{const l=new subject.SlidingWindowLimiter(1,10);expect(l.allow(0)).toBeTrue();expect(l.allow(1)).toBeFalse()});`),
    solutionTest: testFile(`  test("limits and reopens",()=>{const l=new subject.SlidingWindowLimiter(1,10);expect(l.allow(0)).toBeTrue();expect(l.allow(1)).toBeFalse();expect(l.allow(10)).toBeTrue()});`),
    hidden: [
      hiddenFile(`test("inclusive boundary policy",()=>{const l=new subject.SlidingWindowLimiter(2,10);expect(l.allow(0)).toBeTrue();expect(l.allow(9)).toBeTrue();expect(l.allow(10)).toBeTrue();expect(l.snapshot()).toEqual([9,10])});`),
      hiddenFile(`test("clock",()=>{const l=new subject.SlidingWindowLimiter(1,10);l.allow(5);expect(()=>l.allow(4)).toThrow()});`),
      hiddenFile(`test("snapshot copy and bounds",()=>{expect(()=>new subject.SlidingWindowLimiter(0,1)).toThrow();const l=new subject.SlidingWindowLimiter(1,1);l.allow(0);const x=l.snapshot();x.push(9);expect(l.snapshot()).toEqual([0])});`),
    ],
  },
  {
    id: "summary-integration", fold: 5, seed: 1503, category: "integration",
    title: "Integrate benchmark summary classification",
    prompt: "Implement summarizeModels. Deduplicate canonical models, prefer qualified then runnable routes, count qualified/queued/held/unsupported exactly once per model, and return deterministic model order without mutating input. Add tests.",
    starter: `export interface Route{canonical:string;route:string;qualified:boolean;runnable:boolean;supported:boolean} export function summarizeModels(_routes:Route[]){return{models:[],qualified:0,queued:0,held:0,unsupported:0}}\n`,
    solution: `export interface Route{canonical:string;route:string;qualified:boolean;runnable:boolean;supported:boolean} export function summarizeModels(routes:Route[]){const groups=new Map<string,Route[]>();for(const route of routes){const list=groups.get(route.canonical)??[];list.push({...route});groups.set(route.canonical,list)}let qualified=0,queued=0,held=0,unsupported=0;const models=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([canonical,list])=>{const ordered=[...list].sort((a,b)=>Number(b.qualified)-Number(a.qualified)||Number(b.runnable)-Number(a.runnable)||a.route.localeCompare(b.route));const selected=ordered[0]!;if(!list.some(x=>x.supported))unsupported++;else if(list.some(x=>x.qualified))qualified++;else if(list.some(x=>x.runnable))queued++;else held++;return{canonical,route:selected.route}});return{models,qualified,queued,held,unsupported}}\n`,
    visibleTest: testFile(`  test("counts",()=>expect(subject.summarizeModels([{canonical:"a",route:"r",qualified:true,runnable:true,supported:true}]).qualified).toBe(1));`),
    solutionTest: testFile(`  test("dedupes",()=>expect(subject.summarizeModels([{canonical:"a",route:"z",qualified:false,runnable:true,supported:true},{canonical:"a",route:"a",qualified:true,runnable:true,supported:true}])).toEqual({models:[{canonical:"a",route:"a"}],qualified:1,queued:0,held:0,unsupported:0}));`),
    hidden: [
      hiddenFile(`test("all states",()=>{const x=[{canonical:"q",route:"1",qualified:false,runnable:true,supported:true},{canonical:"h",route:"2",qualified:false,runnable:false,supported:true},{canonical:"u",route:"3",qualified:false,runnable:false,supported:false}];expect(subject.summarizeModels(x)).toMatchObject({qualified:0,queued:1,held:1,unsupported:1})});`),
      hiddenFile(`test("order",()=>expect(subject.summarizeModels([{canonical:"z",route:"1",qualified:false,runnable:true,supported:true},{canonical:"a",route:"2",qualified:false,runnable:true,supported:true}]).models.map(x=>x.canonical)).toEqual(["a","z"]));`),
      hiddenFile(`test("immutable",()=>{const x=[{canonical:"a",route:"z",qualified:false,runnable:true,supported:true},{canonical:"a",route:"a",qualified:true,runnable:true,supported:true}];subject.summarizeModels(x);expect(x[0]!.route).toBe("z")});`),
    ],
  },
  {
    id: "immutable-queue", fold: 5, seed: 1504, category: "refactor",
    title: "Refactor queue claiming without mutation",
    prompt: "Refactor claimNext into a pure function. Choose the highest priority ready item, then oldest createdAt, then id. Return cloned selected and remaining values, increment only the selected attempt, and leave input untouched. Add tests.",
    starter: `export interface Item{id:string;priority:number;createdAt:string;state:"ready"|"held";attempt:number} export function claimNext(items:Item[]){const selected=items.sort((a,b)=>b.priority-a.priority).find(x=>x.state==="ready")??null;if(selected)selected.attempt++;return{selected,remaining:items}}\n`,
    solution: `export interface Item{id:string;priority:number;createdAt:string;state:"ready"|"held";attempt:number} export function claimNext(items:Item[]){const selected=[...items].filter(x=>x.state==="ready").sort((a,b)=>b.priority-a.priority||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))[0];if(!selected)return{selected:null,remaining:items.map(x=>({...x}))};const claimed={...selected,attempt:selected.attempt+1};return{selected:claimed,remaining:items.filter(x=>x!==selected).map(x=>({...x}))}}\n`,
    visibleTest: testFile(`  test("priority",()=>expect(subject.claimNext([{id:"a",priority:1,createdAt:"1",state:"ready",attempt:0},{id:"b",priority:2,createdAt:"2",state:"ready",attempt:0}]).selected?.id).toBe("b"));`),
    solutionTest: testFile(`  test("pure",()=>{const x=[{id:"a",priority:1,createdAt:"1",state:"ready" as const,attempt:0}];const r=subject.claimNext(x);expect(r.selected?.attempt).toBe(1);expect(x[0]!.attempt).toBe(0)});`),
    hidden: [
      hiddenFile(`test("ties",()=>expect(subject.claimNext([{id:"b",priority:1,createdAt:"1",state:"ready",attempt:0},{id:"a",priority:1,createdAt:"1",state:"ready",attempt:0}]).selected?.id).toBe("a"));`),
      hiddenFile(`test("held",()=>expect(subject.claimNext([{id:"a",priority:9,createdAt:"1",state:"held",attempt:0},{id:"b",priority:1,createdAt:"2",state:"ready",attempt:0}]).selected?.id).toBe("b"));`),
      hiddenFile(`test("clone remaining",()=>{const x=[{id:"a",priority:1,createdAt:"1",state:"held" as const,attempt:0}];const r=subject.claimNext(x);r.remaining[0]!.attempt=9;expect(x[0]!.attempt).toBe(0)});`),
    ],
  },
  {
    id: "error-taxonomy", fold: 1, seed: 1110, category: "test-creation",
    title: "Add exhaustive error-classification tests",
    prompt: "Add tests for classifyError. Cover rate limits, auth, timeout, invalid JSON, empty output, generic 5xx, and unknown failures. Do not change src/index.ts.",
    starter: `export type ErrorKind="rate_limited"|"auth"|"timeout"|"parse"|"empty"|"provider"|"unknown"; export function classifyError(status:number|null,message:string):ErrorKind{const text=message.toLowerCase();if(status===429)return"rate_limited";if(status===401||status===403)return"auth";if(text.includes("timeout")||text.includes("aborted"))return"timeout";if(text.includes("json"))return"parse";if(text.includes("empty"))return"empty";if(status!==null&&status>=500)return"provider";return"unknown"}\n`,
    solution: `export type ErrorKind="rate_limited"|"auth"|"timeout"|"parse"|"empty"|"provider"|"unknown"; export function classifyError(status:number|null,message:string):ErrorKind{const text=message.toLowerCase();if(status===429)return"rate_limited";if(status===401||status===403)return"auth";if(text.includes("timeout")||text.includes("aborted"))return"timeout";if(text.includes("json"))return"parse";if(text.includes("empty"))return"empty";if(status!==null&&status>=500)return"provider";return"unknown"}\n`,
    visibleTest: testFile(`  test("placeholder",()=>expect(true).toBeTrue());`),
    solutionTest: testFile(`  test("taxonomy",()=>{expect(subject.classifyError(429,"x")).toBe("rate_limited");expect(subject.classifyError(401,"x")).toBe("auth");expect(subject.classifyError(null,"timed out")).toBe("timeout");expect(subject.classifyError(null,"invalid json")).toBe("parse");expect(subject.classifyError(null,"empty payload")).toBe("empty");expect(subject.classifyError(503,"x")).toBe("provider");expect(subject.classifyError(null,"x")).toBe("unknown")});`),
    mutation: `export type ErrorKind="rate_limited"|"auth"|"timeout"|"parse"|"empty"|"provider"|"unknown"; export function classifyError(status:number|null,_message:string):ErrorKind{return status===429?"rate_limited":"unknown"}\n`,
    hidden: [
      hiddenFile(`test("source behavior",()=>expect(subject.classifyError(503,"x")).toBe("provider"));`),
      hiddenFile(`test("message classes",()=>{expect(subject.classifyError(null,"request aborted")).toBe("timeout");expect(subject.classifyError(null,"invalid JSON")).toBe("parse")});`),
      hiddenFile(`test("auth and empty",()=>{expect(subject.classifyError(403,"x")).toBe("auth");expect(subject.classifyError(null,"EMPTY output")).toBe("empty")});`),
    ],
  },
  {
    id: "cycle-detection-tests", fold: 2, seed: 1210, category: "refactor",
    title: "Refactor cycle detection iteratively",
    prompt: "Refactor hasCycle to avoid recursion while preserving directed-graph behavior. It must detect self-cycles and disconnected cycles, reject missing dependency ids, and not mutate input. Add tests.",
    starter: `export interface Node{id:string;deps:string[]} export function hasCycle(nodes:Node[]):boolean{const seen=new Set<string>();function visit(id:string):boolean{if(seen.has(id))return true;seen.add(id);const node=nodes.find(x=>x.id===id);return node?node.deps.some(visit):false}return nodes.some(x=>visit(x.id))}\n`,
    solution: `export interface Node{id:string;deps:string[]} export function hasCycle(nodes:Node[]):boolean{const graph=new Map(nodes.map(n=>[n.id,[...n.deps]]));for(const deps of graph.values())for(const dep of deps)if(!graph.has(dep))throw new Error("missing dependency");const state=new Map<string,0|1|2>();for(const start of graph.keys()){if(state.get(start)===2)continue;const stack:[string,number][]=[[start,0]];state.set(start,1);while(stack.length){const top=stack.at(-1)!;const deps=graph.get(top[0])!;if(top[1]>=deps.length){state.set(top[0],2);stack.pop();continue}const dep=deps[top[1]!]!;top[1]++;if(state.get(dep)===1)return true;if(state.get(dep)!==2){state.set(dep,1);stack.push([dep,0])}}}return false}\n`,
    visibleTest: testFile(`  test("acyclic",()=>expect(subject.hasCycle([{id:"a",deps:[]},{id:"b",deps:["a"]}])).toBeFalse());`),
    solutionTest: testFile(`  test("cycle",()=>expect(subject.hasCycle([{id:"a",deps:["b"]},{id:"b",deps:["a"]}])).toBeTrue());`),
    hidden: [
      hiddenFile(`test("self",()=>expect(subject.hasCycle([{id:"a",deps:["a"]}])).toBeTrue());`),
      hiddenFile(`test("disconnected",()=>expect(subject.hasCycle([{id:"a",deps:[]},{id:"b",deps:["c"]},{id:"c",deps:["b"]}])).toBeTrue());`),
      hiddenFile(`test("missing and immutable",()=>{expect(()=>subject.hasCycle([{id:"a",deps:["x"]}])).toThrow();const x=[{id:"a",deps:[]}];subject.hasCycle(x);expect(x).toEqual([{id:"a",deps:[]}])});`),
    ],
  },
  {
    id: "cost-rounding-tests", fold: 3, seed: 1310, category: "test-creation",
    title: "Add monetary rounding tests",
    prompt: "Add tests for estimateCostMicros. Cover fractional rates, zero usage, large integer usage, and half-up micro-dollar rounding. Do not change src/index.ts.",
    starter: `export function estimateCostMicros(inputTokens:number,outputTokens:number,inputUsdPerMillion:number,outputUsdPerMillion:number):number{for(const value of [inputTokens,outputTokens,inputUsdPerMillion,outputUsdPerMillion])if(!Number.isFinite(value)||value<0)throw new Error("invalid cost input");return Math.round(inputTokens*inputUsdPerMillion+outputTokens*outputUsdPerMillion)}\n`,
    solution: `export function estimateCostMicros(inputTokens:number,outputTokens:number,inputUsdPerMillion:number,outputUsdPerMillion:number):number{for(const value of [inputTokens,outputTokens,inputUsdPerMillion,outputUsdPerMillion])if(!Number.isFinite(value)||value<0)throw new Error("invalid cost input");return Math.round(inputTokens*inputUsdPerMillion+outputTokens*outputUsdPerMillion)}\n`,
    visibleTest: testFile(`  test("placeholder",()=>expect(true).toBeTrue());`),
    solutionTest: testFile(`  test("rounding",()=>{expect(subject.estimateCostMicros(1,0,.5,0)).toBe(1);expect(subject.estimateCostMicros(0,0,9,9)).toBe(0);expect(subject.estimateCostMicros(1_000_000,0,2.5,0)).toBe(2_500_000)});`),
    mutation: `export function estimateCostMicros(inputTokens:number,outputTokens:number,inputUsdPerMillion:number,outputUsdPerMillion:number):number{return Math.floor(inputTokens*inputUsdPerMillion+outputTokens*outputUsdPerMillion)}\n`,
    hidden: [
      hiddenFile(`test("source behavior",()=>expect(subject.estimateCostMicros(1,0,.5,0)).toBe(1));`),
      hiddenFile(`test("large",()=>expect(subject.estimateCostMicros(1_000_000,2_000_000,2.5,3)).toBe(8_500_000));`),
      hiddenFile(`test("invalid",()=>{expect(()=>subject.estimateCostMicros(-1,0,1,1)).toThrow();expect(()=>subject.estimateCostMicros(1,0,Number.NaN,1)).toThrow()});`),
    ],
  },
  {
    id: "error-message-refactor", fold: 4, seed: 1410, category: "refactor",
    title: "Refactor structured provider errors",
    prompt: "Refactor providerError into an exhaustive discriminated union renderer. Preserve the exported API, redact bearer tokens and query token values, include provider and status when present, and add tests.",
    starter: `export interface ProviderError{kind:string;provider:string;status?:number;message:string} export function providerError(error:ProviderError):string{return JSON.stringify(error)}\n`,
    solution: `export type ProviderError={kind:"http";provider:string;status:number;message:string}|{kind:"timeout";provider:string;message:string}|{kind:"parse";provider:string;message:string}; const redact=(value:string)=>value.replace(/Bearer\\s+[A-Za-z0-9._-]+/gi,"Bearer [REDACTED]").replace(/([?&](?:token|key)=)[^&\\s]+/gi,"$1[REDACTED]"); export function providerError(error:ProviderError):string{switch(error.kind){case"http":return"["+error.provider+"] HTTP "+error.status+": "+redact(error.message);case"timeout":return"["+error.provider+"] timeout: "+redact(error.message);case"parse":return"["+error.provider+"] parse: "+redact(error.message)}}\n`,
    visibleTest: testFile(`  test("http",()=>expect(subject.providerError({kind:"http",provider:"p",status:500,message:"bad"})).toBe("[p] HTTP 500: bad"));`),
    solutionTest: testFile(`  test("redacts",()=>expect(subject.providerError({kind:"timeout",provider:"p",message:"Bearer abc.def"})).not.toContain("abc.def"));`),
    hidden: [
      hiddenFile(`test("parse",()=>expect(subject.providerError({kind:"parse",provider:"or",message:"bad json"})).toBe("[or] parse: bad json"));`),
      hiddenFile(`test("query secrets",()=>expect(subject.providerError({kind:"http",provider:"p",status:401,message:"https://x?a=1&token=secret&b=2"})).not.toContain("secret"));`),
      hiddenFile(`test("bearer case",()=>expect(subject.providerError({kind:"timeout",provider:"p",message:"bearer ABC_123"})).toContain("[REDACTED]"));`),
    ],
  },
  {
    id: "config-precedence", fold: 5, seed: 1510, category: "test-creation",
    title: "Add layered configuration tests",
    prompt: "Add tests for resolveConfig. Cover four-layer precedence, undefined preservation, explicit null clearing, unknown-key rejection, and input immutability. Do not change src/index.ts.",
    starter: `export interface Config{model?:string|null;timeoutMs?:number|null;retries?:number|null} const keys=new Set(["model","timeoutMs","retries"]); export function resolveConfig(...layers:Config[]):Config{const out:Config={};for(const layer of layers){for(const [key,value] of Object.entries(layer)){if(!keys.has(key))throw new Error("unknown config key: "+key);if(value!==undefined)(out as Record<string,unknown>)[key]=structuredClone(value)}}return out}\n`,
    solution: `export interface Config{model?:string|null;timeoutMs?:number|null;retries?:number|null} const keys=new Set(["model","timeoutMs","retries"]); export function resolveConfig(...layers:Config[]):Config{const out:Config={};for(const layer of layers){for(const [key,value] of Object.entries(layer)){if(!keys.has(key))throw new Error("unknown config key: "+key);if(value!==undefined)(out as Record<string,unknown>)[key]=structuredClone(value)}}return out}\n`,
    visibleTest: testFile(`  test("placeholder",()=>expect(true).toBeTrue());`),
    solutionTest: testFile(`  test("undefined and null",()=>expect(subject.resolveConfig({model:"a",timeoutMs:1},{model:undefined,timeoutMs:null})).toEqual({model:"a",timeoutMs:null}));`),
    hidden: [
      hiddenFile(`test("four layers",()=>expect(subject.resolveConfig({retries:1},{model:"p"},{timeoutMs:3},{retries:2})).toEqual({retries:2,model:"p",timeoutMs:3}));`),
      hiddenFile(`test("unknown",()=>expect(()=>subject.resolveConfig({extra:1} as any)).toThrow());`),
      hiddenFile(`test("immutable",()=>{const x={model:"a"};const r=subject.resolveConfig(x);r.model="b";expect(x.model).toBe("a")});`),
    ],
    mutation: `export interface Config{model?:string|null;timeoutMs?:number|null;retries?:number|null} export function resolveConfig(...layers:Config[]):Config{return Object.assign({},...layers)}\n`,
  },
];

const excludedTaskIds = new Set([
  "error-taxonomy",
  "cycle-detection-tests",
  "event-reducer",
  "cursor-pagination",
  "retry-budget",
]);

const packageRoot = join(import.meta.dir, "..");
const legacyCorpusRoot = join(packageRoot, "data", "zourobench-code", "corpus");
const corpusRoot = join(packageRoot, "data", "zourobench-code", ".corpus");
rmSync(legacyCorpusRoot, { recursive: true, force: true });
rmSync(corpusRoot, { recursive: true, force: true });
mkdirSync(corpusRoot, { recursive: true });

const tasks: CodingTaskManifest[] = [];
for (const definition of definitions.filter((task) => !excludedTaskIds.has(task.id))) {
  const root = join(corpusRoot, definition.id);
  const starterDir = join(root, "starter");
  const solutionDir = join(root, "private", "solution");
  const hiddenChecksDir = join(root, "private", "hidden");
  for (const dir of [join(starterDir, "src"), join(starterDir, "test"), join(solutionDir, "src"), join(solutionDir, "test"), hiddenChecksDir]) mkdirSync(dir, { recursive: true });
  for (const dir of [starterDir, solutionDir]) {
    writeFileSync(join(dir, "package.json"), pkg);
    writeFileSync(join(dir, "tsconfig.json"), tsconfig);
  }
  writeFileSync(join(starterDir, "src", "index.ts"), definition.starter);
  writeFileSync(join(starterDir, "test", "index.test.ts"), definition.visibleTest);
  writeFileSync(join(solutionDir, "src", "index.ts"), definition.solution);
  writeFileSync(join(solutionDir, "test", "index.test.ts"), definition.solutionTest);
  definition.hidden.forEach((content, index) => writeFileSync(join(hiddenChecksDir, `check-${index + 1}.test.ts`), content));
  writeFileSync(join(hiddenChecksDir, "mutation.ts"), definition.mutation ?? definition.starter);
  const relativeRoot = `data/zourobench-code/.corpus/${definition.id}`;
  tasks.push({
    id: definition.id,
    fold: definition.fold,
    seed: definition.seed,
    category: definition.category,
    title: definition.title,
    prompt: definition.prompt,
    targetFile: "src/index.ts",
    starterDir: `${relativeRoot}/starter`,
    solutionDir: `${relativeRoot}/private/solution`,
    hiddenChecksDir: `${relativeRoot}/private/hidden`,
    mutationFile: `${relativeRoot}/private/hidden/mutation.ts`,
    timeoutMs: 300_000,
    maxChangedFiles: 4,
    maxChangedLines: 220,
    requiredCommands: [["tsc", "--noEmit", "-p", "tsconfig.json"], ["bun", "test", "test"]],
    hiddenCommands: definition.hidden.map((_, index) => ["bun", "test", `./.zbc-hidden/check-${index + 1}.test.ts`]),
  });
}

const manifest: CodingCorpusManifest = {
  schemaVersion: 1,
  benchmark: "ZouroBench-Code",
  corpusVersion: "2026.08.04-v1",
  generatedAt: "2026-08-04T00:00:00.000Z",
  policy: "five-fold-typescript-bun-v1",
  tasks,
};
const errors = validateCodingManifest(manifest);
if (errors.length) throw new Error(`generated invalid corpus:\n${errors.join("\n")}`);
writeFileSync(join(packageRoot, "data", "zourobench-code", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${tasks.length} ZouroBench Code tasks across five folds.`);
