import type { EventEnvelope } from "../domain/events.js";
import type { RoutingTarget } from "../domain/types.js";

export interface Projection<TState> {
  readonly name: string;
  initialState(): TState;
  apply(state: TState, event: EventEnvelope): TState;
}

export interface ProjectionRunResult<TState> {
  projectionName: string;
  state: TState;
  lastEventId?: string;
  processedEvents: number;
}

export interface ProjectionOffset {
  projectionName: string;
  eventId: string;
  updatedAt: string;
}

export interface CoreProjectionStates {
  projectState: unknown;
  agents: unknown;
  inbox: unknown;
  tasks: unknown;
  claims: unknown;
  reviews: unknown;
  verification: unknown;
  conversations: unknown;
}

export function routingTargetKey(target: RoutingTarget): string {
  switch (target.kind) {
    case "agent":
      return `agent:${target.name}`;
    case "role":
      return `role:${target.role}`;
    case "runtime-role":
      return `runtime-role:${target.runtime}:${target.role}`;
    case "session":
      return `session:${target.sessionId}`;
    case "broadcast":
      return `broadcast:${target.runtime ?? "*"}:${target.role ?? "*"}`;
  }
}
