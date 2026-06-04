import type { EventEnvelope } from "../domain/events.js";
import type {
  ConversationParticipant,
  DeliveryAttemptStatus,
  DeliveryMode,
  DeliveryOutcome,
  InboxItemStatus,
  LinkedRecord,
  ReplyPolicy,
  RoutingTarget
} from "../domain/types.js";
import { type AgentsProjectionState, endpointById, endpointByName } from "./agents.js";
import {
  payloadRecord,
  readConversationParticipant,
  readDeliveryMode,
  readDeliveryOutcome,
  readLinkedRecords,
  readReplyPolicy,
  readRoutingTarget,
  readRoutingTargets,
  readString,
  readStringArray,
  readVerificationStatus
} from "./event-readers.js";
import type { Projection } from "./types.js";
import { routingTargetKey } from "./types.js";

export type InboxProjectionItemKind = "message" | "coordination";

export interface InboxProjectionItem {
  id: string;
  projectId: string;
  kind: InboxProjectionItemKind;
  target: RoutingTarget;
  status: InboxItemStatus;
  sourceEventId: string;
  sourceEventType: string;
  reason: string;
  conversationId?: string;
  messageId?: string;
  body?: string;
  replyPolicy?: ReplyPolicy;
  sender?: ConversationParticipant;
  linkedRecords: LinkedRecord[];
  claimedBySessionId?: string;
  createdAt: string;
  updatedAt: string;
  readAt?: string;
  dismissedAt?: string;
  dismissedReason?: string;
}

export interface DeliveryAttemptProjectionItem {
  id: string;
  projectId: string;
  inboxItemId: string;
  messageId: string;
  target: RoutingTarget;
  deliveryMode: DeliveryMode;
  status: DeliveryAttemptStatus;
  attemptedAt: string;
  deliveredAt?: string;
  outcome?: DeliveryOutcome;
  error?: string;
}

export interface InboxProjectionState {
  items: InboxProjectionItem[];
  deliveryAttempts: DeliveryAttemptProjectionItem[];
}

const terminalStatuses = new Set<InboxItemStatus>(["read", "cancelled"]);

export const inboxProjection: Projection<InboxProjectionState> = {
  name: "inbox",
  initialState: () => ({
    items: [],
    deliveryAttempts: []
  }),
  apply: (state, event) => {
    switch (event.type) {
      case "message.sent":
        return queueMessageRecipients(state, event, "message_sent");
      case "conversation.message_routed":
        return queueMessageRecipients(state, event, "message_routed");
      case "review.requested":
        return queueCoordinationItem(state, event, {
          idSuffix: "review_request",
          target: readRoutingTarget(payloadRecord(event).reviewer),
          reason: "review_requested",
          linkedRecords: compactLinkedRecords([
            linkedRecord("review_request", event.target.reviewRequestId),
            linkedRecord("implementation_claim", event.target.implementationClaimId),
            linkedRecord("task", event.target.taskId)
          ])
        });
      case "implementation.claim_recorded":
        return queueCoordinationItem(state, event, {
          idSuffix: "reviewer",
          target: { kind: "role", role: "reviewer" },
          reason: "implementation_claim_review",
          linkedRecords: compactLinkedRecords([
            linkedRecord("implementation_claim", event.target.implementationClaimId),
            linkedRecord("assignment", event.target.assignmentId),
            linkedRecord("task", event.target.taskId)
          ])
        });
      case "review.finding_recorded":
        return queueCoordinationItem(state, event, {
          idSuffix: "implementer",
          target: { kind: "role", role: "implementer" },
          reason: "review_finding_address",
          linkedRecords: compactLinkedRecords([
            linkedRecord("review_finding", event.target.reviewFindingId),
            linkedRecord("review_request", event.target.reviewRequestId),
            linkedRecord("implementation_claim", event.target.implementationClaimId),
            linkedRecord("task", event.target.taskId)
          ])
        });
      case "review.finding_addressed":
        return queueCoordinationItem(state, event, {
          idSuffix: "reviewer",
          target: { kind: "role", role: "reviewer" },
          reason: "review_finding_rereview",
          linkedRecords: compactLinkedRecords([
            linkedRecord("review_finding", event.target.reviewFindingId),
            linkedRecord("review_request", event.target.reviewRequestId),
            linkedRecord("implementation_claim", event.target.implementationClaimId),
            linkedRecord("task", event.target.taskId)
          ])
        });
      case "verification.recorded":
        return queueFailedVerificationIfNeeded(state, event);
      case "inbox.item_claimed":
        return updateInboxItem(state, event, "claimed");
      case "inbox.item_dismissed":
        return dismissInboxItem(state, event);
      case "delivery.attempted":
        return recordDeliveryAttempt(state, event, "attempted");
      case "delivery.delivered":
        return recordDeliveryAttempt(state, event, "delivered");
      case "delivery.failed":
        return recordDeliveryAttempt(state, event, "failed");
      case "message.read":
        return markRead(state, event);
      default:
        return state;
    }
  }
};

export function getInboxForAgentName(
  state: InboxProjectionState,
  agents: AgentsProjectionState,
  agentName: string
): InboxProjectionItem[] {
  const endpoint = endpointByName(agents, agentName);

  if (!endpoint) {
    return [];
  }

  return state.items
    .filter((item) => !terminalStatuses.has(item.status))
    .filter((item) => {
      const target = item.target;

      switch (target.kind) {
        case "agent":
          return target.name === endpoint.name;
        case "role":
          return target.role === endpoint.role;
        case "runtime-role":
          return target.role === endpoint.role && target.runtime === endpoint.runtime;
        case "session":
          return agents.sessions.some(
            (session) => session.id === target.sessionId && session.agentId === endpoint.id
          );
        case "broadcast":
          return (
            (!target.role || target.role === endpoint.role) &&
            (!target.runtime || target.runtime === endpoint.runtime)
          );
      }

      return false;
    })
    .sort(compareInboxItem);
}

export function getInboxForSession(
  state: InboxProjectionState,
  agents: AgentsProjectionState,
  sessionId: string
): InboxProjectionItem[] {
  const session = agents.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    return [];
  }

  const endpoint = endpointById(agents, session.agentId);
  if (!endpoint) {
    return [];
  }

  return state.items
    .filter((item) => !terminalStatuses.has(item.status))
    .filter((item) => {
      const target = item.target;

      switch (target.kind) {
        case "agent":
          return target.name === endpoint.name;
        case "role":
          return target.role === session.role;
        case "runtime-role":
          return target.role === session.role && target.runtime === session.runtime;
        case "session":
          return target.sessionId === session.id;
        case "broadcast":
          return (
            (!target.role || target.role === session.role) &&
            (!target.runtime || target.runtime === session.runtime)
          );
      }

      return false;
    })
    .sort(compareInboxItem);
}

export interface InboxDismissCandidates {
  dismissible: InboxProjectionItem[];
  shared: InboxProjectionItem[];
}

/**
 * Split an agent's non-terminal inbox items into directly dismissible items
 * (concrete agent/session targets) and shared items (role/runtime-role/broadcast)
 * that may affect other agents. Shared items are only included when they match
 * the endpoint, mirroring {@link getInboxForAgentName}. Unlike that helper, the
 * two sets are kept separate so the CLI can dismiss direct items by default and
 * require an explicit opt-in for shared ones.
 */
export function selectInboxDismissCandidates(
  state: InboxProjectionState,
  agents: AgentsProjectionState,
  agentName: string
): InboxDismissCandidates {
  const endpoint = endpointByName(agents, agentName);

  if (!endpoint) {
    return { dismissible: [], shared: [] };
  }

  const dismissible: InboxProjectionItem[] = [];
  const shared: InboxProjectionItem[] = [];

  for (const item of state.items) {
    if (terminalStatuses.has(item.status)) {
      continue;
    }

    const target = item.target;

    switch (target.kind) {
      case "agent":
        if (target.name === endpoint.name) {
          dismissible.push(item);
        }
        break;
      case "session":
        if (
          agents.sessions.some(
            (session) => session.id === target.sessionId && session.agentId === endpoint.id
          )
        ) {
          dismissible.push(item);
        }
        break;
      case "role":
        if (target.role === endpoint.role) {
          shared.push(item);
        }
        break;
      case "runtime-role":
        if (target.role === endpoint.role && target.runtime === endpoint.runtime) {
          shared.push(item);
        }
        break;
      case "broadcast":
        if (
          (!target.role || target.role === endpoint.role) &&
          (!target.runtime || target.runtime === endpoint.runtime)
        ) {
          shared.push(item);
        }
        break;
    }
  }

  return { dismissible, shared };
}

function queueMessageRecipients(
  state: InboxProjectionState,
  event: EventEnvelope,
  reason: "message_sent" | "message_routed"
): InboxProjectionState {
  const conversationId = event.target.conversationId;
  const messageId = event.target.messageId;

  if (!conversationId || !messageId) {
    return state;
  }

  const payload = payloadRecord(event);
  const recipients = readRoutingTargets(payload, "recipients");
  const inboxItemIds = readStringArray(payload, "inboxItemIds");
  const sender = readConversationParticipant(payload.sender);
  const body = readString(payload, "body");
  const replyPolicy = readReplyPolicy(payload.replyPolicy) ?? "optional";
  const linkedRecords = readLinkedRecords(payload, "linkedRecords");

  const queuedItems = recipients.flatMap((target, index) => {
    if (hasMessageTarget(state, messageId, target)) {
      return [];
    }

    const explicitId = inboxItemIds[index];

    return [
      {
        id: explicitId ?? `inbox_${event.id}_${index}`,
        projectId: event.projectId,
        kind: "message" as const,
        target,
        status: "queued" as const,
        sourceEventId: event.id,
        sourceEventType: event.type,
        reason,
        conversationId,
        messageId,
        body,
        replyPolicy,
        sender,
        linkedRecords,
        createdAt: event.createdAt,
        updatedAt: event.createdAt
      }
    ];
  });

  if (queuedItems.length === 0) {
    return state;
  }

  return {
    ...state,
    items: [...state.items, ...queuedItems].sort(compareInboxItem)
  };
}

function queueCoordinationItem(
  state: InboxProjectionState,
  event: EventEnvelope,
  options: {
    idSuffix: string;
    target?: RoutingTarget;
    reason: string;
    linkedRecords: LinkedRecord[];
  }
): InboxProjectionState {
  if (!options.target) {
    return state;
  }

  const item: InboxProjectionItem = {
    id: `inbox_${event.id}_${options.idSuffix}`,
    projectId: event.projectId,
    kind: "coordination",
    target: options.target,
    status: "queued",
    sourceEventId: event.id,
    sourceEventType: event.type,
    reason: options.reason,
    conversationId: event.target.conversationId,
    replyPolicy: "none",
    linkedRecords: options.linkedRecords,
    createdAt: event.createdAt,
    updatedAt: event.createdAt
  };

  if (state.items.some((candidate) => candidate.id === item.id)) {
    return state;
  }

  return {
    ...state,
    items: [...state.items, item].sort(compareInboxItem)
  };
}

function queueFailedVerificationIfNeeded(
  state: InboxProjectionState,
  event: EventEnvelope
): InboxProjectionState {
  const payload = payloadRecord(event);
  const status = readVerificationStatus(payload.status);

  if (status !== "failed") {
    return state;
  }

  return queueCoordinationItem(state, event, {
    idSuffix: "verification_failed",
    target: { kind: "role", role: "implementer" },
    reason: "verification_failed",
    linkedRecords: compactLinkedRecords([
      linkedRecord("verification_result", event.target.verificationId),
      linkedRecord("implementation_claim", event.target.implementationClaimId),
      linkedRecord("review_finding", event.target.reviewFindingId),
      linkedRecord("task", event.target.taskId)
    ])
  });
}

function updateInboxItem(
  state: InboxProjectionState,
  event: EventEnvelope,
  status: InboxItemStatus
): InboxProjectionState {
  const payload = payloadRecord(event);
  const inboxItemId = event.target.inboxItemId ?? readString(payload, "inboxItemId");
  const sessionId = readString(payload, "sessionId");

  if (!inboxItemId) {
    return state;
  }

  return {
    ...state,
    items: state.items.map((item) =>
      item.id === inboxItemId
        ? {
            ...item,
            status,
            claimedBySessionId: sessionId ?? item.claimedBySessionId,
            updatedAt: event.createdAt
          }
        : item
    )
  };
}

function dismissInboxItem(state: InboxProjectionState, event: EventEnvelope): InboxProjectionState {
  const payload = payloadRecord(event);
  const inboxItemId = event.target.inboxItemId ?? readString(payload, "inboxItemId");
  const reason = readString(payload, "reason");

  if (!inboxItemId) {
    return state;
  }

  return {
    ...state,
    items: state.items.map((item) =>
      item.id === inboxItemId
        ? {
            ...item,
            status: "cancelled",
            dismissedAt: event.createdAt,
            dismissedReason: reason,
            updatedAt: event.createdAt
          }
        : item
    )
  };
}

function recordDeliveryAttempt(
  state: InboxProjectionState,
  event: EventEnvelope,
  status: DeliveryAttemptStatus
): InboxProjectionState {
  const payload = payloadRecord(event);
  const deliveryMode = readDeliveryMode(payload.deliveryMode);
  const recipient = readRoutingTarget(payload.recipient);
  const deliveryAttemptId = event.target.deliveryAttemptId;
  const inboxItemId = event.target.inboxItemId;
  const messageId = event.target.messageId;

  if (!deliveryAttemptId || !inboxItemId || !messageId || !deliveryMode || !recipient) {
    return state;
  }

  const attempt: DeliveryAttemptProjectionItem = {
    id: deliveryAttemptId,
    projectId: event.projectId,
    inboxItemId,
    messageId,
    target: recipient,
    deliveryMode,
    status,
    attemptedAt: event.createdAt,
    deliveredAt: status === "delivered" ? event.createdAt : undefined,
    outcome: status === "delivered" ? readDeliveryOutcome(payload.outcome) : undefined,
    error: status === "failed" ? readString(payload, "error") : undefined
  };

  const itemStatus: InboxItemStatus =
    status === "delivered" ? "delivered" : status === "failed" ? "failed" : "queued";

  return {
    ...state,
    items: state.items.map((item) =>
      item.id === inboxItemId
        ? terminalStatuses.has(item.status)
          ? item
          : {
              ...item,
              status:
                item.status === "claimed" && itemStatus === "queued" ? item.status : itemStatus,
              updatedAt: event.createdAt
            }
        : item
    ),
    deliveryAttempts: upsertDeliveryAttempt(state.deliveryAttempts, attempt)
  };
}

function markRead(state: InboxProjectionState, event: EventEnvelope): InboxProjectionState {
  const payload = payloadRecord(event);
  const inboxItemId = event.target.inboxItemId ?? readString(payload, "inboxItemId");
  const messageId = event.target.messageId ?? readString(payload, "messageId");

  if (!inboxItemId && !messageId) {
    return state;
  }

  return {
    ...state,
    items: state.items.map((item) => {
      const matches = inboxItemId ? item.id === inboxItemId : item.messageId === messageId;

      return matches
        ? {
            ...item,
            status: "read",
            readAt: event.createdAt,
            updatedAt: event.createdAt
          }
        : item;
    })
  };
}

function upsertDeliveryAttempt(
  attempts: DeliveryAttemptProjectionItem[],
  attempt: DeliveryAttemptProjectionItem
): DeliveryAttemptProjectionItem[] {
  const next = attempts.some((candidate) => candidate.id === attempt.id)
    ? attempts.map((candidate) =>
        candidate.id === attempt.id
          ? {
              ...candidate,
              ...attempt,
              attemptedAt: candidate.attemptedAt
            }
          : candidate
      )
    : [...attempts, attempt];

  return next.sort((left, right) => left.attemptedAt.localeCompare(right.attemptedAt));
}

function hasMessageTarget(
  state: InboxProjectionState,
  messageId: string,
  target: RoutingTarget
): boolean {
  return state.items.some(
    (item) =>
      item.messageId === messageId && routingTargetKey(item.target) === routingTargetKey(target)
  );
}

function linkedRecord(
  kind: LinkedRecord["kind"],
  id: string | undefined
): LinkedRecord | undefined {
  return id
    ? {
        kind,
        id
      }
    : undefined;
}

function compactLinkedRecords(records: Array<LinkedRecord | undefined>): LinkedRecord[] {
  return records.filter((record): record is LinkedRecord => Boolean(record));
}

function compareInboxItem(left: InboxProjectionItem, right: InboxProjectionItem): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
