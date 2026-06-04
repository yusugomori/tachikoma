import type { EventEnvelope } from "../domain/events.js";
import type { Projection, ProjectionRunResult } from "./types.js";

export function runProjection<TState>(
  projection: Projection<TState>,
  events: EventEnvelope[]
): ProjectionRunResult<TState> {
  let state = projection.initialState();
  let lastEventId: string | undefined;

  for (const event of events) {
    state = projection.apply(state, event);
    lastEventId = event.id;
  }

  return {
    projectionName: projection.name,
    state,
    lastEventId,
    processedEvents: events.length
  };
}

export function runProjectionSet<TProjection extends Projection<unknown>>(
  projections: TProjection[],
  events: EventEnvelope[]
): Record<string, ProjectionRunResult<unknown>> {
  const results: Record<string, ProjectionRunResult<unknown>> = {};

  for (const projection of projections) {
    results[projection.name] = runProjection(projection, events);
  }

  return results;
}
