import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEvent } from "../../src/domain/events.js";
import { EventStore } from "../../src/store/event-store.js";
import { applyMigrations } from "../../src/store/migrator.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("SQLite event store", () => {
  it("applies migrations to a temporary database", () => {
    const store = openTempStore({ migrate: false });

    try {
      applyMigrations(store.db);

      const tables = store.db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
        .all()
        .map((row) => row.name);

      expect(tables).toContain("events");
      expect(tables).toContain("projection_offsets");
      expect(tables).toContain("schema_migrations");
    } finally {
      store.close();
    }
  });

  it("appends and lists events in forward order", () => {
    const store = openTempStore();
    const eventStore = new EventStore(store.db);

    try {
      const first = createEvent(
        {
          id: "evt_first",
          projectId: "proj_events",
          type: "project.initialized",
          payload: {
            name: "tachikoma"
          }
        },
        "2026-06-01T00:00:00.000Z"
      );
      const second = createEvent(
        {
          id: "evt_second",
          projectId: "proj_events",
          type: "agent.endpoint_registered",
          target: {
            agentId: "agent_codex_reviewer"
          },
          payload: {
            name: "loki"
          }
        },
        "2026-06-01T00:00:01.000Z"
      );

      eventStore.appendBatch([first, second]);

      expect(eventStore.listForward("proj_events").map((event) => event.id)).toEqual([
        "evt_first",
        "evt_second"
      ]);
      expect(eventStore.getById("evt_second").type).toBe("agent.endpoint_registered");
    } finally {
      store.close();
    }
  });

  it("does not expose SQLite row ids as event ids", () => {
    const store = openTempStore();
    const eventStore = new EventStore(store.db);

    try {
      const event = createEvent({
        projectId: "proj_events",
        type: "message.sent",
        target: {
          conversationId: "conv_test",
          messageId: "msg_test"
        },
        payload: {
          sender: {
            kind: "system"
          },
          recipients: [
            {
              kind: "agent",
              name: "loki"
            }
          ],
          body: "hello",
          replyPolicy: "required"
        }
      });

      const appended = eventStore.append(event);
      const row = store.db
        .prepare<[string], { sequence: number; id: string }>(
          "SELECT sequence, id FROM events WHERE id = ?"
        )
        .get(appended.id);

      expect(row).toBeDefined();
      expect(appended.id).toMatch(/^evt_/);
      expect(appended.id).not.toBe(String(row?.sequence));
    } finally {
      store.close();
    }
  });
});

function openTempStore(options: { migrate?: boolean } = {}): SqliteStore {
  const root = mkdtempSync(join(tmpdir(), "tachikoma-event-store-"));
  tempRoots.push(root);
  return SqliteStore.open(join(root, "tachikoma.sqlite"), options);
}
