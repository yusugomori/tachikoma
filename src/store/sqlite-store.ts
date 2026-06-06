import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { StoreUnavailableError } from "../domain/errors.js";
import { applyMigrations } from "./migrator.js";
import type { DatabaseConnection } from "./transaction.js";

export interface SqliteStoreOptions {
  migrate?: boolean;
  readonly?: boolean;
}

export class SqliteStore {
  public readonly db: DatabaseConnection;

  public constructor(
    public readonly storePath: string,
    options: SqliteStoreOptions = {}
  ) {
    try {
      if (storePath !== ":memory:" && !options.readonly) {
        mkdirSync(dirname(storePath), { recursive: true });
      }

      this.db = new Database(storePath, {
        readonly: options.readonly ?? false,
        fileMustExist: options.readonly ?? false
      });

      configureDatabase(this.db, { readonly: options.readonly ?? false });

      if (options.migrate ?? !options.readonly) {
        applyMigrations(this.db);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "MigrationFailedError") {
        throw error;
      }

      throw new StoreUnavailableError(storePath);
    }
  }

  public static open(storePath: string, options: SqliteStoreOptions = {}): SqliteStore {
    return new SqliteStore(storePath, options);
  }

  public close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }
}

export function configureDatabase(
  db: DatabaseConnection,
  options: { readonly?: boolean } = {}
): void {
  db.pragma("foreign_keys = ON");
  if (options.readonly) {
    db.pragma("query_only = ON");
    return;
  }

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
}
