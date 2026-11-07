import { Db } from "../src/db";

/** A fresh in-memory database with all tables, like the Python tests' `session` fixture. */
export function memoryDb(): Db {
  const db = new Db("sqlite:///:memory:");
  db.prepare();
  return db;
}
