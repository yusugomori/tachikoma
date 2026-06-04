import type { EventEnvelope } from "../domain/events.js";
import type { ImplementationClaim } from "../domain/types.js";
import { payloadRecord, readString, readStringArray } from "./event-readers.js";
import type { Projection } from "./types.js";

export interface ClaimsProjectionState {
  claims: ImplementationClaim[];
}

export const claimsProjection: Projection<ClaimsProjectionState> = {
  name: "claims",
  initialState: () => ({
    claims: []
  }),
  apply: (state, event) => {
    if (event.type !== "implementation.claim_recorded") {
      return state;
    }

    const claim = readImplementationClaim(event);

    if (!claim) {
      return state;
    }

    return {
      ...state,
      claims: upsertClaim(state.claims, claim)
    };
  }
};

export function claimsForTask(state: ClaimsProjectionState, taskId: string): ImplementationClaim[] {
  return state.claims
    .filter((claim) => claim.taskId === taskId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function claimById(
  state: ClaimsProjectionState,
  claimId: string
): ImplementationClaim | undefined {
  return state.claims.find((claim) => claim.id === claimId);
}

function readImplementationClaim(event: EventEnvelope): ImplementationClaim | undefined {
  const payload = payloadRecord(event);
  const claimId =
    event.target.implementationClaimId ?? readString(payload, "implementationClaimId");
  const summary = readString(payload, "summary");

  if (!claimId || !summary) {
    return undefined;
  }

  return {
    id: claimId,
    projectId: event.projectId,
    taskId: event.target.taskId ?? readString(payload, "taskId"),
    assignmentId: event.target.assignmentId ?? readString(payload, "assignmentId"),
    conversationId: event.target.conversationId ?? readString(payload, "conversationId"),
    sessionId: event.target.sessionId ?? event.actor.sessionId ?? readString(payload, "sessionId"),
    agentId: event.target.agentId ?? event.actor.agentId ?? readString(payload, "agentId"),
    summary,
    files: readStringArray(payload, "files"),
    addressedFindingIds: readStringArray(payload, "addressedFindingIds"),
    verificationExpectation: readString(payload, "verificationExpectation"),
    createdAt: event.createdAt
  };
}

function upsertClaim(
  claims: ImplementationClaim[],
  claim: ImplementationClaim
): ImplementationClaim[] {
  const next = claims.some((candidate) => candidate.id === claim.id)
    ? claims.map((candidate) => (candidate.id === claim.id ? claim : candidate))
    : [...claims, claim];

  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
