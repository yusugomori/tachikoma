import type { EventEnvelope } from "../domain/events.js";
import type {
  AgentEndpoint,
  AgentRole,
  AgentRuntime,
  Presence,
  RoutingTarget,
  Session
} from "../domain/types.js";
import {
  payloadRecord,
  readAgentRole,
  readAgentRuntime,
  readDeliveryMode,
  readString,
  readStringArray
} from "./event-readers.js";
import type { Projection } from "./types.js";

export interface AgentsProjectionState {
  endpoints: AgentEndpoint[];
  sessions: Session[];
  presence: Presence[];
}

export type RoutingResolution =
  | {
      status: "resolved";
      target: RoutingTarget;
      endpoint: AgentEndpoint;
      liveSessionIds: string[];
      delivery: "live" | "queued";
    }
  | {
      status: "role-inbox";
      target: Extract<RoutingTarget, { kind: "role" | "runtime-role" }>;
    }
  | {
      status: "ambiguous";
      target: Extract<RoutingTarget, { kind: "role" | "runtime-role" }>;
      candidates: AgentEndpoint[];
    }
  | {
      status: "broadcast";
      target: Extract<RoutingTarget, { kind: "broadcast" }>;
      endpoints: AgentEndpoint[];
    }
  | {
      status: "unknown";
      target: RoutingTarget;
    };

export const agentsProjection: Projection<AgentsProjectionState> = {
  name: "agents",
  initialState: () => ({
    endpoints: [],
    sessions: [],
    presence: []
  }),
  apply: (state, event) => {
    switch (event.type) {
      case "agent.endpoint_registered":
        return applyEndpointRegistered(state, event);
      case "session.started":
        return applySessionStarted(state, event);
      case "session.ended":
        return applySessionEnded(state, event);
      case "agent.presence_announced":
        return applyPresenceAnnounced(state, event);
      case "agent.presence_expired":
        return applyPresenceExpired(state, event);
      default:
        return state;
    }
  }
};

export function resolveRoutingTarget(
  state: AgentsProjectionState,
  target: RoutingTarget
): RoutingResolution {
  switch (target.kind) {
    case "agent": {
      const endpoint = endpointByName(state, target.name);

      if (!endpoint) {
        return { status: "unknown", target };
      }

      const liveSessionIds = liveSessionsForEndpoint(state, endpoint).map((session) => session.id);

      return {
        status: "resolved",
        target,
        endpoint,
        liveSessionIds,
        delivery: liveSessionIds.length > 0 ? "live" : "queued"
      };
    }
    case "role":
    case "runtime-role": {
      const candidates = matchingEndpoints(state, target);

      if (candidates.length === 0) {
        return { status: "role-inbox", target };
      }

      if (candidates.length > 1) {
        return {
          status: "ambiguous",
          target,
          candidates
        };
      }

      const endpoint = candidates[0];
      if (!endpoint) {
        return { status: "role-inbox", target };
      }

      const liveSessionIds = liveSessionsForEndpoint(state, endpoint).map((session) => session.id);

      return {
        status: "resolved",
        target,
        endpoint,
        liveSessionIds,
        delivery: liveSessionIds.length > 0 ? "live" : "queued"
      };
    }
    case "session": {
      const session = state.sessions.find(
        (candidate) => candidate.id === target.sessionId && !candidate.endedAt
      );

      if (!session) {
        return { status: "unknown", target };
      }

      const endpoint = state.endpoints.find((candidate) => candidate.id === session.agentId);
      if (!endpoint) {
        return { status: "unknown", target };
      }

      return {
        status: "resolved",
        target,
        endpoint,
        liveSessionIds: [session.id],
        delivery: "live"
      };
    }
    case "broadcast":
      return {
        status: "broadcast",
        target,
        endpoints: state.endpoints
          .filter((endpoint) => matchesBroadcast(endpoint, target.runtime, target.role))
          .sort(compareEndpoint)
      };
  }
}

export function endpointByName(
  state: AgentsProjectionState,
  name: string
): AgentEndpoint | undefined {
  return state.endpoints.find((endpoint) => endpoint.name === name);
}

export function endpointById(
  state: AgentsProjectionState,
  agentId: string
): AgentEndpoint | undefined {
  return state.endpoints.find((endpoint) => endpoint.id === agentId);
}

export function liveSessionsForEndpoint(
  state: AgentsProjectionState,
  endpoint: AgentEndpoint
): Session[] {
  const liveSessionIds = new Set(
    state.presence
      .filter((presence) => presence.agentId === endpoint.id)
      .map((presence) => presence.sessionId)
  );

  return state.sessions
    .filter((session) => session.agentId === endpoint.id && !session.endedAt)
    .filter((session) => liveSessionIds.has(session.id))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function applyEndpointRegistered(
  state: AgentsProjectionState,
  event: EventEnvelope
): AgentsProjectionState {
  const payload = payloadRecord(event);
  const name = readString(payload, "name");
  const runtime = readAgentRuntime(payload.runtime);
  const role = readAgentRole(payload.role);
  const agentId = event.target.agentId ?? readString(payload, "agentId");

  if (!name || !runtime || !agentId) {
    return state;
  }

  const endpoint: AgentEndpoint = {
    id: agentId,
    projectId: event.projectId,
    name,
    runtime,
    ...(role ? { role } : {}),
    createdAt: event.createdAt,
    updatedAt: event.createdAt
  };

  return {
    ...state,
    endpoints: upsertEndpoint(state.endpoints, endpoint)
  };
}

function applySessionStarted(
  state: AgentsProjectionState,
  event: EventEnvelope
): AgentsProjectionState {
  const payload = payloadRecord(event);
  const agentId = event.target.agentId ?? readString(payload, "agentId");
  const sessionId = event.target.sessionId ?? readString(payload, "sessionId");
  const endpoint = agentId ? endpointById(state, agentId) : undefined;
  const runtime = readAgentRuntime(payload.runtime) ?? endpoint?.runtime ?? event.actor.runtime;
  const role = readAgentRole(payload.role) ?? endpoint?.role ?? event.actor.role;
  const deliveryMode = readDeliveryMode(payload.deliveryMode) ?? "turn";

  if (!agentId || !sessionId || !runtime) {
    return state;
  }

  const session: Session = {
    id: sessionId,
    projectId: event.projectId,
    agentId,
    runtime,
    ...(role ? { role } : {}),
    deliveryMode,
    cwd: readString(payload, "cwd"),
    startedAt: event.createdAt
  };

  return {
    ...state,
    sessions: upsertSession(state.sessions, session)
  };
}

function applySessionEnded(
  state: AgentsProjectionState,
  event: EventEnvelope
): AgentsProjectionState {
  const payload = payloadRecord(event);
  const sessionId = event.target.sessionId ?? readString(payload, "sessionId");

  if (!sessionId) {
    return state;
  }

  return {
    ...state,
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? {
            ...session,
            endedAt: event.createdAt
          }
        : session
    )
  };
}

function applyPresenceAnnounced(
  state: AgentsProjectionState,
  event: EventEnvelope
): AgentsProjectionState {
  const payload = payloadRecord(event);
  const agentId = event.target.agentId ?? readString(payload, "agentId");
  const sessionId = event.target.sessionId ?? readString(payload, "sessionId");
  const presenceId = event.target.presenceId ?? readString(payload, "presenceId");
  const deliveryMode = readDeliveryMode(payload.deliveryMode);

  if (!agentId || !sessionId || !presenceId || !deliveryMode) {
    return state;
  }

  const presence: Presence = {
    id: presenceId,
    projectId: event.projectId,
    agentId,
    sessionId,
    deliveryMode,
    capabilities: readStringArray(payload, "capabilities"),
    lastSeenAt: event.createdAt
  };

  return {
    ...state,
    presence: upsertPresence(state.presence, presence)
  };
}

function applyPresenceExpired(
  state: AgentsProjectionState,
  event: EventEnvelope
): AgentsProjectionState {
  const payload = payloadRecord(event);
  const presenceId = event.target.presenceId ?? readString(payload, "presenceId");
  const sessionId = event.target.sessionId ?? readString(payload, "sessionId");
  const agentId = event.target.agentId ?? readString(payload, "agentId");

  return {
    ...state,
    presence: state.presence.filter((presence) => {
      if (presenceId) {
        return presence.id !== presenceId;
      }

      if (sessionId) {
        return presence.sessionId !== sessionId;
      }

      if (agentId) {
        return presence.agentId !== agentId;
      }

      return true;
    })
  };
}

function matchingEndpoints(
  state: AgentsProjectionState,
  target: Extract<RoutingTarget, { kind: "role" | "runtime-role" }>
): AgentEndpoint[] {
  return state.endpoints
    .filter((endpoint) => {
      if (target.kind === "role") {
        return endpoint.role === target.role;
      }

      return endpoint.role === target.role && endpoint.runtime === target.runtime;
    })
    .sort(compareEndpoint);
}

function matchesBroadcast(
  endpoint: AgentEndpoint,
  runtime?: AgentRuntime,
  role?: AgentRole
): boolean {
  return (!runtime || endpoint.runtime === runtime) && (!role || endpoint.role === role);
}

function upsertEndpoint(endpoints: AgentEndpoint[], endpoint: AgentEndpoint): AgentEndpoint[] {
  const existing = endpoints.find((candidate) => candidate.id === endpoint.id);
  const next = existing
    ? endpoints.map((candidate) =>
        candidate.id === endpoint.id
          ? {
              ...candidate,
              ...endpoint,
              createdAt: candidate.createdAt
            }
          : candidate
      )
    : [...endpoints, endpoint];

  return next.sort(compareEndpoint);
}

function upsertSession(sessions: Session[], session: Session): Session[] {
  const next = sessions.some((candidate) => candidate.id === session.id)
    ? sessions.map((candidate) => (candidate.id === session.id ? session : candidate))
    : [...sessions, session];

  return next.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function upsertPresence(presenceList: Presence[], presence: Presence): Presence[] {
  const next = presenceList.some((candidate) => candidate.id === presence.id)
    ? presenceList.map((candidate) => (candidate.id === presence.id ? presence : candidate))
    : [...presenceList, presence];

  return next.sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt));
}

function compareEndpoint(left: AgentEndpoint, right: AgentEndpoint): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}
