import type { EventEnvelope } from "../domain/events.js";
import type { VerificationResult } from "../domain/types.js";
import { payloadRecord, readString, readVerificationStatus } from "./event-readers.js";
import type { Projection } from "./types.js";

export interface MissingVerificationExpectation {
  implementationClaimId: string;
  taskId?: string;
  conversationId?: string;
  expectation: string;
  createdAt: string;
}

export interface VerificationProjectionState {
  results: VerificationResult[];
  failed: VerificationResult[];
  skipped: VerificationResult[];
  manualPending: VerificationResult[];
  missingExpectations: MissingVerificationExpectation[];
}

export const verificationProjection: Projection<VerificationProjectionState> = {
  name: "verification",
  initialState: () => ({
    results: [],
    failed: [],
    skipped: [],
    manualPending: [],
    missingExpectations: []
  }),
  apply: (state, event) => {
    switch (event.type) {
      case "implementation.claim_recorded":
        return applyClaimExpectation(state, event);
      case "verification.recorded":
        return applyVerificationRecorded(state, event);
      default:
        return state;
    }
  }
};

function applyClaimExpectation(
  state: VerificationProjectionState,
  event: EventEnvelope
): VerificationProjectionState {
  const payload = payloadRecord(event);
  const implementationClaimId =
    event.target.implementationClaimId ?? readString(payload, "implementationClaimId");
  const expectation = readString(payload, "verificationExpectation");

  if (!implementationClaimId || !expectation) {
    return state;
  }

  const missing: MissingVerificationExpectation = {
    implementationClaimId,
    taskId: event.target.taskId ?? readString(payload, "taskId"),
    conversationId: event.target.conversationId ?? readString(payload, "conversationId"),
    expectation,
    createdAt: event.createdAt
  };

  return {
    ...state,
    missingExpectations: upsertMissingExpectation(state.missingExpectations, missing)
  };
}

function applyVerificationRecorded(
  state: VerificationProjectionState,
  event: EventEnvelope
): VerificationProjectionState {
  const payload = payloadRecord(event);
  const verificationId = event.target.verificationId ?? readString(payload, "verificationId");
  const status = readVerificationStatus(payload.status);
  const summary = readString(payload, "summary");

  if (!verificationId || !status || !summary) {
    return state;
  }

  const result: VerificationResult = {
    id: verificationId,
    projectId: event.projectId,
    taskId: event.target.taskId ?? readString(payload, "taskId"),
    conversationId: event.target.conversationId ?? readString(payload, "conversationId"),
    implementationClaimId:
      event.target.implementationClaimId ?? readString(payload, "implementationClaimId"),
    reviewFindingId: event.target.reviewFindingId ?? readString(payload, "reviewFindingId"),
    command: readString(payload, "command"),
    status,
    summary,
    createdAt: event.createdAt
  };

  const results = upsertVerificationResult(state.results, result);

  return {
    results,
    failed: results.filter((candidate) => candidate.status === "failed"),
    skipped: results.filter((candidate) => candidate.status === "skipped"),
    manualPending: results.filter((candidate) => candidate.status === "manual_pending"),
    missingExpectations: state.missingExpectations.filter(
      (missing) => missing.implementationClaimId !== result.implementationClaimId
    )
  };
}

function upsertMissingExpectation(
  missingExpectations: MissingVerificationExpectation[],
  missing: MissingVerificationExpectation
): MissingVerificationExpectation[] {
  const next = missingExpectations.some(
    (candidate) => candidate.implementationClaimId === missing.implementationClaimId
  )
    ? missingExpectations.map((candidate) =>
        candidate.implementationClaimId === missing.implementationClaimId ? missing : candidate
      )
    : [...missingExpectations, missing];

  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function upsertVerificationResult(
  results: VerificationResult[],
  result: VerificationResult
): VerificationResult[] {
  const next = results.some((candidate) => candidate.id === result.id)
    ? results.map((candidate) => (candidate.id === result.id ? result : candidate))
    : [...results, result];

  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
