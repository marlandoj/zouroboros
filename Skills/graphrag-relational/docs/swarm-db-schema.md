# swarm.db Schema Evidence

Date: 2026-07-13

Database path:
`/home/workspace/Projects/zouroboros-software-factory/swarm.db`

## File Type

The ticket requested SQLite `PRAGMA table_info` and `PRAGMA foreign_key_list`
evidence. The specified file is not SQLite:

```text
$ file /home/workspace/Projects/zouroboros-software-factory/swarm.db
/home/workspace/Projects/zouroboros-software-factory/swarm.db: DuckDB database file, version 64
```

Header sample:

```text
00000000: 52d2 bebe f4b9 7e92 4455 434b 4000 0000  R.....~.DUCK@...
00000030: 0000 0000 7631 2e34 2e32 0000 0000 0000  ....v1.4.2......
```

SQLite rejected the file:

```text
$ sqlite3 /home/workspace/Projects/zouroboros-software-factory/swarm.db ".tables"
Error: file is not a database
```

## Table Catalog

DuckDB catalog query:

```sql
SHOW TABLES;
```

Result:

```text
0 rows
```

Information schema cross-check:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'main'
ORDER BY table_name;
```

Result:

```text
0 rows
```

## Column Schema

There are no user tables in the database, so there are no per-table
`table_info` rows to report.

If tables are added later, use the DuckDB equivalent:

```sql
PRAGMA table_info('table_name');
```

## Foreign Keys

DuckDB referential constraint query:

```sql
SELECT constraint_name, table_name, constraint_type
FROM information_schema.table_constraints
WHERE table_schema = 'main'
ORDER BY table_name, constraint_name;
```

Result:

```text
0 rows
```

Referential constraints cross-check:

```sql
SELECT *
FROM information_schema.referential_constraints;
```

Result:

```text
0 rows
```

## Summary

`swarm.db` currently has no user tables and no foreign-key constraints. The
schema extraction path for this ticket therefore documents an empty DuckDB
catalog, not a SQLite schema.

