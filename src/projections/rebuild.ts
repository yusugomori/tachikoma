import type { EventStore } from "../store/event-store.js";
import type { DatabaseConnection } from "../store/transaction.js";
import { runProjection, runProjectionSet } from "./engine.js";
import type { Projection, ProjectionOffset, ProjectionRunResult } from "./types.js";

export function rebuildProjection<TState>(
  eventStore: EventStore,
  projectId: string,
  projection: Projection<TState>
): ProjectionRunResult<TState> {
  return runProjection(projection, eventStore.listForward(projectId));
}

export function rebuildProjectionSet(
  eventStore: EventStore,
  projectId: string,
  projections: Projection<unknown>[]
): Record<string, ProjectionRunResult<unknown>> {
  return runProjectionSet(projections, eventStore.listForward(projectId));
}

export function saveProjectionOffset(
  db: DatabaseConnection,
  projectionName: string,
  eventId: string,
  updatedAt = new Date().toISOString()
): ProjectionOffset {
  db.prepare<[string, string, string]>(`
    INSERT INTO projection_offsets (projection_name, event_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(projection_name)
    DO UPDATE SET event_id = excluded.event_id, updated_at = excluded.updated_at
  `).run(projectionName, eventId, updatedAt);

  return {
    projectionName,
    eventId,
    updatedAt
  };
}

export function getProjectionOffset(
  db: DatabaseConnection,
  projectionName: string
): ProjectionOffset | undefined {
  const row = db
    .prepare<[string], { projection_name: string; event_id: string; updated_at: string }>(`
      SELECT projection_name, event_id, updated_at
      FROM projection_offsets
      WHERE projection_name = ?
    `)
    .get(projectionName);

  if (!row) {
    return undefined;
  }

  return {
    projectionName: row.projection_name,
    eventId: row.event_id,
    updatedAt: row.updated_at
  };
}

export function clearProjectionOffset(db: DatabaseConnection, projectionName: string): void {
  db.prepare<[string]>("DELETE FROM projection_offsets WHERE projection_name = ?").run(
    projectionName
  );
}
