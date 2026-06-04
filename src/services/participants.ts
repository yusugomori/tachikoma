import type { EventActor } from "../domain/events.js";
import type { ConversationParticipant, RoutingTarget } from "../domain/types.js";

export function actorToParticipant(actor: EventActor): ConversationParticipant {
  if (actor.name || actor.agentId) {
    return {
      kind: "agent",
      name: actor.name ?? actor.agentId ?? "agent",
      agentId: actor.agentId,
      runtime: actor.runtime,
      role: actor.role,
      sessionId: actor.sessionId
    };
  }

  if (actor.runtime && actor.role) {
    return {
      kind: "runtime-role",
      runtime: actor.runtime,
      role: actor.role
    };
  }

  if (actor.role) {
    return {
      kind: "role",
      role: actor.role
    };
  }

  if (actor.sessionId) {
    return {
      kind: "session",
      sessionId: actor.sessionId
    };
  }

  return {
    kind: "system"
  };
}

export function routingTargetToParticipant(
  target: RoutingTarget
): ConversationParticipant | undefined {
  switch (target.kind) {
    case "agent":
      return {
        kind: "agent",
        name: target.name
      };
    case "role":
      return {
        kind: "role",
        role: target.role
      };
    case "runtime-role":
      return {
        kind: "runtime-role",
        runtime: target.runtime,
        role: target.role
      };
    case "session":
      return {
        kind: "session",
        sessionId: target.sessionId
      };
    case "broadcast":
      return undefined;
  }
}

export function participantToRoutingTarget(
  participant: ConversationParticipant
): RoutingTarget | undefined {
  switch (participant.kind) {
    case "agent":
      return {
        kind: "agent",
        name: participant.name
      };
    case "role":
      return {
        kind: "role",
        role: participant.role
      };
    case "runtime-role":
      return {
        kind: "runtime-role",
        runtime: participant.runtime,
        role: participant.role
      };
    case "session":
      return {
        kind: "session",
        sessionId: participant.sessionId
      };
    case "system":
    case "user":
      return undefined;
  }
}

export function sameParticipant(
  left: ConversationParticipant,
  right: ConversationParticipant
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "agent":
      return right.kind === "agent" && left.name === right.name;
    case "role":
      return right.kind === "role" && left.role === right.role;
    case "runtime-role":
      return (
        right.kind === "runtime-role" && left.runtime === right.runtime && left.role === right.role
      );
    case "session":
      return right.kind === "session" && left.sessionId === right.sessionId;
    case "system":
      return right.kind === "system";
    case "user":
      return right.kind === "user" && left.name === right.name;
  }
}
