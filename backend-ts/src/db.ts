// Database access. SQLite needs no server, so setup stays free and simple.
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";
import { Column, nameKey, TABLES } from "./schema";
import { REPO_ROOT } from "./settings";

export type Row = Record<string, any>;
type Value = string | number | boolean | null | Uint8Array | undefined;

const SQL_TYPE: Record<Column["type"], string> = { int: "INTEGER", text: "TEXT", bool: "INTEGER", blob: "BLOB", date: "TEXT", datetime: "TEXT" };

/** "sqlite:///data/paidloop.db" or "sqlite:///:memory:" to a file path (or :memory:). */
export function databasePath(url: string): string {
  const match = /^sqlite:\/\/\/(.*)$/.exec(url);
  if (!match) throw new Error(`Only sqlite URLs are supported, got ${url}`);
  const file = match[1];
  if (file === "" || file === ":memory:") return ":memory:";
  return isAbsolute(file) ? file : resolve(REPO_ROOT, file);
}

function columnSql(name: string, column: Column, key: boolean): string {
  const parts = [`"${name}"`, SQL_TYPE[column.type]];
  if (key) parts.push("PRIMARY KEY", ...(column.type === "int" ? ["AUTOINCREMENT"] : []));
  else if (!column.nullable) parts.push("NOT NULL");
  if (column.unique) parts.push("UNIQUE");
  if (column.references) parts.push(`REFERENCES "${column.references}"("id")`);
  return parts.join(" ");
}

export class Db {
  readonly raw: Database.Database;
  readonly path: string;
  private readonly statements = new Map<string, Database.Statement>();

  constructor(url: string) {
    this.path = databasePath(url);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.raw = new Database(this.path, { timeout: 30000 });
    this.raw.pragma("foreign_keys = ON");
    if (this.path !== ":memory:") {
      // Lets the screens read while the background payment check writes.
      this.raw.pragma("journal_mode = WAL");
      this.raw.pragma("synchronous = NORMAL");
    }
  }

  close(): void {
    this.raw.close();
  }

  /**
   * Bring any database up to date: new tables, new columns and new indexes. Safe to run every start.
   * CREATE TABLE IF NOT EXISTS alone adds neither columns nor indexes to tables that already exist.
   */
  prepare(): void {
    for (const [table, spec] of Object.entries(TABLES)) {
      const columns = Object.entries(spec.columns).map(([name, column]) => columnSql(name, column, name === spec.key));
      this.raw.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${columns.join(", ")})`);
      const present = new Set((this.raw.prepare(`PRAGMA table_info("${table}")`).all() as Row[]).map((row) => row.name));
      for (const [name, column] of Object.entries(spec.columns)) {
        // An added column cannot be NOT NULL without a default, so old rows get the column's default
        if (!present.has(name)) this.raw.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${SQL_TYPE[column.type]}${this.defaultSql(column)}`);
      }
      for (const [index, columnsOfIndex] of Object.entries(spec.indexes)) {
        this.raw.exec(`CREATE INDEX IF NOT EXISTS "${index}" ON "${table}" (${columnsOfIndex.map((c) => `"${c}"`).join(", ")})`);
      }
    }
    // Customers saved before the search key existed get it now.
    const missing = this.raw.prepare(`SELECT id, name FROM customer WHERE name_key IS NULL OR name_key = ''`).all() as Row[];
    for (const customer of missing) this.raw.prepare(`UPDATE customer SET name_key = ? WHERE id = ?`).run(nameKey(customer.name), customer.id);
    // Lets SQLite learn the data, so it picks the best index for each query.
    this.raw.pragma("optimize");
  }

  /** Remove every table and make them again, empty. Used by the demo reset. */
  dropAll(): void {
    this.raw.pragma("foreign_keys = OFF");
    for (const table of Object.keys(TABLES)) this.raw.exec(`DROP TABLE IF EXISTS "${table}"`);
    this.raw.pragma("foreign_keys = ON");
    this.statements.clear();
    this.prepare();
  }

  private defaultSql(column: Column): string {
    const value = column.default;
    if (value === undefined || value === "now") return column.nullable ? "" : column.type === "int" || column.type === "bool" ? " DEFAULT 0" : " DEFAULT ''";
    if (value === null) return "";
    if (typeof value === "number") return ` DEFAULT ${value}`;
    if (typeof value === "boolean") return ` DEFAULT ${value ? 1 : 0}`;
    return ` DEFAULT '${value.replaceAll("'", "''")}'`;
  }

  // ---- reading and writing rows, with booleans and defaults handled from the table list

  private toDb(value: Value): string | number | null | Uint8Array {
    if (value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  }

  private fromDb(table: string, row: Row | undefined): Row | undefined {
    if (!row) return row;
    const spec = TABLES[table].columns;
    for (const name of Object.keys(row)) if (spec[name]?.type === "bool" && row[name] !== null) row[name] = row[name] === 1;
    return row;
  }

  /** The columns a normal read returns: everything except the big files. */
  columns(table: string, withFiles: string[] = []): string {
    return Object.entries(TABLES[table].columns)
      .filter(([name, column]) => !column.deferred || withFiles.includes(name))
      .map(([name]) => `"${table}"."${name}"`)
      .join(", ");
  }

  insert(table: string, values: Row): number {
    const spec = TABLES[table];
    for (const name of Object.keys(values)) if (!(name in spec.columns)) throw new Error(`${table} has no column ${name}`);
    const names: string[] = [];
    const params: unknown[] = [];
    for (const [name, column] of Object.entries(spec.columns)) {
      if (name === spec.key && column.type === "int" && values[name] === undefined) continue;
      let value = values[name];
      if (value === undefined) value = column.default === "now" ? new Date().toISOString() : (column.default as Value);
      names.push(`"${name}"`);
      params.push(this.toDb(value));
    }
    const sql = `INSERT INTO "${table}" (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
    const result = this.statement(sql).run(...params);
    return Number(result.lastInsertRowid);
  }

  update(table: string, id: number | string, patch: Row): void {
    const spec = TABLES[table];
    const names = Object.keys(patch);
    if (!names.length) return;
    for (const name of names) if (!(name in spec.columns)) throw new Error(`${table} has no column ${name}`);
    const sql = `UPDATE "${table}" SET ${names.map((n) => `"${n}" = ?`).join(", ")} WHERE "${spec.key}" = ?`;
    this.statement(sql).run(...names.map((n) => this.toDb(patch[n])), id);
  }

  get(table: string, id: number | string, withFiles: string[] = []): Row | undefined {
    const key = TABLES[table].key!;
    const row = this.statement(`SELECT ${this.columns(table, withFiles)} FROM "${table}" WHERE "${key}" = ?`).get(id) as Row | undefined;
    return this.fromDb(table, row);
  }

  /** Runs a query that returns rows of one table (use db.columns(table) in the SELECT). */
  rows(table: string, sql: string, ...params: unknown[]): Row[] {
    return (this.statement(sql).all(...params.map((p) => this.toDb(p as Value))) as Row[]).map((row) => this.fromDb(table, row)!);
  }

  row(table: string, sql: string, ...params: unknown[]): Row | undefined {
    return this.fromDb(table, this.statement(sql).get(...params.map((p) => this.toDb(p as Value))) as Row | undefined);
  }

  /** Any query, rows as they come (no conversion): counts, sums, joins. */
  query(sql: string, ...params: unknown[]): Row[] {
    return this.statement(sql).all(...params.map((p) => this.toDb(p as Value))) as Row[];
  }

  scalar<T = number>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.statement(sql).get(...params.map((p) => this.toDb(p as Value))) as Row | undefined;
    return row ? (Object.values(row)[0] as T) : undefined;
  }

  run(sql: string, ...params: unknown[]): number {
    return this.statement(sql).run(...params.map((p) => this.toDb(p as Value))).changes;
  }

  delete(table: string, id: number | string): void {
    this.statement(`DELETE FROM "${table}" WHERE "${TABLES[table].key}" = ?`).run(id);
  }

  /** Several changes that stand or fall together. Nested calls join the outer one. */
  transaction<T>(work: () => T): T {
    if (this.raw.inTransaction) return work();
    return this.raw.transaction(work).immediate();
  }

  private statement(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
}
