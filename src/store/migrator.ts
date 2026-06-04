import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MigrationFailedError } from "../domain/errors.js";
import type { DatabaseConnection } from "./transaction.js";

interface Migration {
  id: string;
  filename: string;
}

const migrations: Migration[] = [
  {
    id: "001_initial",
    filename: "001_initial.sql"
  }
];

const storeDir = dirname(fileURLToPath(import.meta.url));

export function ensureMigrationTable(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at text NOT NULL
    );
  `);
}

export function applyMigrations(db: DatabaseConnection): void {
  ensureMigrationTable(db);

  for (const migration of migrations) {
    const existing = db
      .prepare<[string], { id: string }>("SELECT id FROM schema_migrations WHERE id = ?")
      .get(migration.id);

    if (existing) {
      continue;
    }

    try {
      db.transaction(() => {
        db.exec(readMigration(migration.filename));
        db.prepare<[string, string]>(
          "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)"
        ).run(migration.id, new Date().toISOString());
      })();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new MigrationFailedError(message);
    }
  }
}

function readMigration(filename: string): string {
  return readFileSync(join(storeDir, "migrations", filename), "utf8");
}
