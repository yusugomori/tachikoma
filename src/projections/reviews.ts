import type { EventEnvelope } from "../domain/events.js";
import type { ReviewFinding, ReviewRequest } from "../domain/types.js";
import {
  payloadRecord,
  readReviewFindingStatus,
  readRoutingTarget,
  readString
} from "./event-readers.js";
import type { Projection } from "./types.js";

export interface ReviewsProjectionState {
  requests: ReviewRequest[];
  findings: ReviewFinding[];
}

export const reviewsProjection: Projection<ReviewsProjectionState> = {
  name: "reviews",
  initialState: () => ({
    requests: [],
    findings: []
  }),
  apply: (state, event) => {
    switch (event.type) {
      case "review.requested":
        return applyReviewRequested(state, event);
      case "review.finding_recorded":
        return applyFindingRecorded(state, event);
      case "review.finding_addressed":
        return updateFindingStatus(state, event, "addressed");
      case "review.finding_accepted":
        return updateFindingStatus(state, event, "accepted");
      case "review.finding_reopened":
        return updateFindingStatus(state, event, "reopened");
      default:
        return state;
    }
  }
};

export function openFindings(state: ReviewsProjectionState): ReviewFinding[] {
  return state.findings
    .filter((finding) => finding.status === "open" || finding.status === "reopened")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function addressedFindings(state: ReviewsProjectionState): ReviewFinding[] {
  return state.findings
    .filter((finding) => finding.status === "addressed")
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
}

function applyReviewRequested(
  state: ReviewsProjectionState,
  event: EventEnvelope
): ReviewsProjectionState {
  const payload = payloadRecord(event);
  const requestId = event.target.reviewRequestId ?? readString(payload, "reviewRequestId");
  const target = readRoutingTarget(payload.reviewer) ?? readRoutingTarget(payload.target);
  const scope = readString(payload, "scope");

  if (!requestId || !target || !scope) {
    return state;
  }

  const request: ReviewRequest = {
    id: requestId,
    projectId: event.projectId,
    taskId: event.target.taskId ?? readString(payload, "taskId"),
    conversationId: event.target.conversationId ?? readString(payload, "conversationId"),
    implementationClaimId:
      event.target.implementationClaimId ?? readString(payload, "implementationClaimId"),
    target,
    scope,
    createdAt: event.createdAt
  };

  return {
    ...state,
    requests: upsertRequest(state.requests, request)
  };
}

function applyFindingRecorded(
  state: ReviewsProjectionState,
  event: EventEnvelope
): ReviewsProjectionState {
  const payload = payloadRecord(event);
  const findingId = event.target.reviewFindingId ?? readString(payload, "reviewFindingId");
  const summary = readString(payload, "summary");

  if (!findingId || !summary) {
    return state;
  }

  const finding: ReviewFinding = {
    id: findingId,
    projectId: event.projectId,
    reviewRequestId: event.target.reviewRequestId ?? readString(payload, "reviewRequestId"),
    taskId: event.target.taskId ?? readString(payload, "taskId"),
    conversationId: event.target.conversationId ?? readString(payload, "conversationId"),
    implementationClaimId:
      event.target.implementationClaimId ?? readString(payload, "implementationClaimId"),
    summary,
    status: readReviewFindingStatus(payload.status) ?? "open",
    createdAt: event.createdAt,
    updatedAt: event.createdAt
  };

  return {
    ...state,
    findings: upsertFinding(state.findings, finding)
  };
}

function updateFindingStatus(
  state: ReviewsProjectionState,
  event: EventEnvelope,
  status: ReviewFinding["status"]
): ReviewsProjectionState {
  const payload = payloadRecord(event);
  const findingId = event.target.reviewFindingId ?? readString(payload, "reviewFindingId");

  if (!findingId) {
    return state;
  }

  return {
    ...state,
    findings: state.findings.map((finding) =>
      finding.id === findingId
        ? {
            ...finding,
            status,
            updatedAt: event.createdAt
          }
        : finding
    )
  };
}

function upsertRequest(requests: ReviewRequest[], request: ReviewRequest): ReviewRequest[] {
  const next = requests.some((candidate) => candidate.id === request.id)
    ? requests.map((candidate) => (candidate.id === request.id ? request : candidate))
    : [...requests, request];

  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function upsertFinding(findings: ReviewFinding[], finding: ReviewFinding): ReviewFinding[] {
  const next = findings.some((candidate) => candidate.id === finding.id)
    ? findings.map((candidate) => (candidate.id === finding.id ? finding : candidate))
    : [...findings, finding];

  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
