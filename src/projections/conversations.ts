import type { EventEnvelope } from "../domain/events.js";
import type {
  ConversationParticipant,
  ConversationThread,
  LinkedRecord,
  Message,
  RoutingTarget
} from "../domain/types.js";
import {
  payloadRecord,
  readConversationParticipant,
  readLinkedRecords,
  readReplyPolicy,
  readRoutingTargets,
  readString,
  readStringArray
} from "./event-readers.js";
import type { Projection } from "./types.js";

export interface ConversationRoute {
  conversationId: string;
  messageId: string;
  recipients: RoutingTarget[];
  inboxItemIds: string[];
  routedAt: string;
}

export interface ConversationsProjectionState {
  threads: ConversationThread[];
  messages: Message[];
  routes: ConversationRoute[];
}

export const conversationsProjection: Projection<ConversationsProjectionState> = {
  name: "conversations",
  initialState: () => ({
    threads: [],
    messages: [],
    routes: []
  }),
  apply: (state, event) => {
    switch (event.type) {
      case "conversation.opened":
        return applyConversationOpened(state, event);
      case "message.sent":
        return applyMessageSent(state, event);
      case "conversation.message_routed":
        return applyMessageRouted(state, event);
      case "conversation.closed":
        return applyConversationClosed(state, event);
      default:
        return state;
    }
  }
};

export function openThreads(state: ConversationsProjectionState): ConversationThread[] {
  return state.threads
    .filter((thread) => thread.status === "open")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function messagesForThread(
  state: ConversationsProjectionState,
  conversationId: string
): Message[] {
  return state.messages
    .filter((message) => message.conversationId === conversationId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function applyConversationOpened(
  state: ConversationsProjectionState,
  event: EventEnvelope
): ConversationsProjectionState {
  const payload = payloadRecord(event);
  const conversationId = event.target.conversationId ?? readString(payload, "conversationId");
  const title = readString(payload, "title");

  if (!conversationId || !title) {
    return state;
  }

  const participants = Array.isArray(payload.participants)
    ? payload.participants.flatMap((participant) => {
        const parsed = readConversationParticipant(participant);
        return parsed ? [parsed] : [];
      })
    : [];

  const thread: ConversationThread = {
    id: conversationId,
    projectId: event.projectId,
    title,
    participants,
    linkedRecords: readLinkedRecords(payload, "linkedRecords"),
    status: "open",
    createdAt: event.createdAt,
    updatedAt: event.createdAt
  };

  return {
    ...state,
    threads: upsertThread(state.threads, thread)
  };
}

function applyMessageSent(
  state: ConversationsProjectionState,
  event: EventEnvelope
): ConversationsProjectionState {
  const payload = payloadRecord(event);
  const conversationId = event.target.conversationId;
  const messageId = event.target.messageId;
  const sender = readConversationParticipant(payload.sender);
  const recipients = readRoutingTargets(payload, "recipients");
  const body = readString(payload, "body");

  if (!conversationId || !messageId || !sender || !body) {
    return state;
  }

  const linkedRecords = readLinkedRecords(payload, "linkedRecords");
  const message: Message = {
    id: messageId,
    projectId: event.projectId,
    conversationId,
    sender,
    recipients,
    body,
    replyPolicy: readReplyPolicy(payload.replyPolicy) ?? "optional",
    linkedRecords,
    createdAt: event.createdAt
  };

  return {
    ...state,
    threads: ensureThread(state.threads, event, conversationId, sender, linkedRecords),
    messages: upsertMessage(state.messages, message)
  };
}

function applyMessageRouted(
  state: ConversationsProjectionState,
  event: EventEnvelope
): ConversationsProjectionState {
  const conversationId = event.target.conversationId;
  const messageId = event.target.messageId;

  if (!conversationId || !messageId) {
    return state;
  }

  const payload = payloadRecord(event);
  const route: ConversationRoute = {
    conversationId,
    messageId,
    recipients: readRoutingTargets(payload, "recipients"),
    inboxItemIds: readStringArray(payload, "inboxItemIds"),
    routedAt: event.createdAt
  };

  return {
    ...state,
    routes: upsertRoute(state.routes, route)
  };
}

function applyConversationClosed(
  state: ConversationsProjectionState,
  event: EventEnvelope
): ConversationsProjectionState {
  const payload = payloadRecord(event);
  const conversationId = event.target.conversationId ?? readString(payload, "conversationId");

  if (!conversationId) {
    return state;
  }

  return {
    ...state,
    threads: state.threads.map((thread) =>
      thread.id === conversationId
        ? {
            ...thread,
            status: "closed",
            updatedAt: event.createdAt
          }
        : thread
    )
  };
}

function ensureThread(
  threads: ConversationThread[],
  event: EventEnvelope,
  conversationId: string,
  sender: ConversationParticipant,
  linkedRecords: LinkedRecord[]
): ConversationThread[] {
  if (threads.some((thread) => thread.id === conversationId)) {
    return threads.map((thread) =>
      thread.id === conversationId
        ? {
            ...thread,
            participants: addParticipant(thread.participants, sender),
            linkedRecords: mergeLinkedRecords(thread.linkedRecords, linkedRecords),
            updatedAt: event.createdAt
          }
        : thread
    );
  }

  const thread: ConversationThread = {
    id: conversationId,
    projectId: event.projectId,
    title: conversationId,
    participants: [sender],
    linkedRecords,
    status: "open",
    createdAt: event.createdAt,
    updatedAt: event.createdAt
  };

  return [...threads, thread].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function upsertThread(
  threads: ConversationThread[],
  thread: ConversationThread
): ConversationThread[] {
  const next = threads.some((candidate) => candidate.id === thread.id)
    ? threads.map((candidate) => (candidate.id === thread.id ? thread : candidate))
    : [...threads, thread];

  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const next = messages.some((candidate) => candidate.id === message.id)
    ? messages.map((candidate) => (candidate.id === message.id ? message : candidate))
    : [...messages, message];

  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function upsertRoute(routes: ConversationRoute[], route: ConversationRoute): ConversationRoute[] {
  const next = routes.some(
    (candidate) =>
      candidate.conversationId === route.conversationId && candidate.messageId === route.messageId
  )
    ? routes.map((candidate) =>
        candidate.conversationId === route.conversationId && candidate.messageId === route.messageId
          ? route
          : candidate
      )
    : [...routes, route];

  return next.sort((left, right) => left.routedAt.localeCompare(right.routedAt));
}

function addParticipant(
  participants: ConversationParticipant[],
  participant: ConversationParticipant
): ConversationParticipant[] {
  const encoded = JSON.stringify(participant);
  if (participants.some((candidate) => JSON.stringify(candidate) === encoded)) {
    return participants;
  }

  return [...participants, participant];
}

function mergeLinkedRecords(left: LinkedRecord[], right: LinkedRecord[]): LinkedRecord[] {
  const byKey = new Map<string, LinkedRecord>();

  for (const record of [...left, ...right]) {
    byKey.set(`${record.kind}:${record.id}`, record);
  }

  return [...byKey.values()];
}
