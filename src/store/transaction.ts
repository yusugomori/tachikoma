import type Database from "better-sqlite3";

export type DatabaseConnection = Database.Database;

export function runInTransaction<T>(db: DatabaseConnection, fn: () => T): T {
  return db.transaction(fn)();
}
