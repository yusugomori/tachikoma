import { EventNotFoundError } from "../domain/errors.js";
import { type EventEnvelope, type EventType, eventEnvelopeSchema } from "../domain/events.js";
import type { DatabaseConnection } from "./transaction.js";

interface EventRow {
  id: string;
  project_id: string;
  type: EventType;
  schema_version: number;
  actor: string;
  target: string;
  payload: string;
  created_at: string;
}

interface CountRow {
  count: number;
}

export interface EventStoreListOptions {
  afterId?: string;
  limit?: number;
  types?: EventType[];
}

export class EventStore {
  public constructor(private readonly db: DatabaseConnection) {}

  public append(event: EventEnvelope): EventEnvelope {
    const parsed = eventEnvelopeSchema.parse(event);

    this.db
      .prepare<[string, string, EventType, number, string, string, string, string]>(`
        INSERT INTO events (
          id, project_id, type, schema_version, actor, target, payload, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        parsed.id,
        parsed.projectId,
        parsed.type,
        parsed.schemaVersion,
        JSON.stringify(parsed.actor),
        JSON.stringify(parsed.target),
        JSON.stringify(parsed.payload),
        parsed.createdAt
      );

    return parsed;
  }

  public appendBatch(events: EventEnvelope[]): EventEnvelope[] {
    return this.db.transaction(() => events.map((event) => this.append(event)))();
  }

  public getById(eventId: string): EventEnvelope {
    const row = this.db
      .prepare<[string], EventRow>(`
        SELECT id, project_id, type, schema_version, actor, target, payload, created_at
        FROM events
        WHERE id = ?
      `)
      .get(eventId);

    if (!row) {
      throw new EventNotFoundError(eventId);
    }

    return mapEventRow(row);
  }

  public listForward(projectId: string, options: EventStoreListOptions = {}): EventEnvelope[] {
    const afterSequence = options.afterId ? this.sequenceForEvent(options.afterId) : 0;
    const rows = this.db
      .prepare<[string, number, number], EventRow>(`
        SELECT id, project_id, type, schema_version, actor, target, payload, created_at
        FROM events
        WHERE project_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?
      `)
      .all(projectId, afterSequence, options.limit ?? -1)
      .map(mapEventRow);

    if (!options.types) {
      return rows;
    }

    return rows.filter((event) => options.types?.includes(event.type));
  }

  public count(projectId: string): number {
    return (
      this.db
        .prepare<[string], CountRow>("SELECT count(*) AS count FROM events WHERE project_id = ?")
        .get(projectId)?.count ?? 0
    );
  }

  private sequenceForEvent(eventId: string): number {
    const row = this.db
      .prepare<[string], { sequence: number }>("SELECT sequence FROM events WHERE id = ?")
      .get(eventId);

    if (!row) {
      throw new EventNotFoundError(eventId);
    }

    return row.sequence;
  }
}

function mapEventRow(row: EventRow): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    schemaVersion: row.schema_version,
    actor: JSON.parse(row.actor) as unknown,
    target: JSON.parse(row.target) as unknown,
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at
  });
}
