import type { EventEnvelope } from "../../domain/events.js";
import type { ServiceContext, Services, WakeableRecipient } from "../../services/index.js";
import type { HostHookInput } from "./types.js";

export interface SentHookInput {
  host: HostHookInput;
  events?: EventEnvelope[];
}

export interface SentHookResult {
  handled: boolean;
  wakeableRecipients: WakeableRecipient[];
  output: string;
}

const TACHIKOMA_ROUTING_TOOLS = new Set([
  "tachikoma_ask",
  "tachikoma_reply",
  "tachikoma_claim_record",
  "tachikoma_review_request",
  "tachikoma_review_finding",
  "tachikoma_review_address",
  "tachikoma_review_accept",
  "tachikoma_review_reopen",
  "tachikoma_review_approve",
  "tachikoma_verification_record",
  "mcp__tachikoma__tachikoma_ask",
  "mcp__tachikoma__tachikoma_reply",
  "mcp__tachikoma__tachikoma_claim_record",
  "mcp__tachikoma__tachikoma_review_request",
  "mcp__tachikoma__tachikoma_review_finding",
  "mcp__tachikoma__tachikoma_review_address",
  "mcp__tachikoma__tachikoma_review_accept",
  "mcp__tachikoma__tachikoma_review_reopen",
  "mcp__tachikoma__tachikoma_review_approve",
  "mcp__tachikoma__tachikoma_verification_record"
]);

const WAKEABLE_SOURCE_TYPES = new Set([
  "message.sent",
  "conversation.message_routed",
  "implementation.claim_recorded",
  "review.requested",
  "review.finding_recorded",
  "review.finding_addressed",
  "verification.recorded"
]);

export function runSentHook(
  context: ServiceContext,
  services: Services,
  input: SentHookInput
): SentHookResult {
  if (!isTachikomaRoutingTool(input.host.toolName)) {
    return {
      handled: false,
      wakeableRecipients: [],
      output: ""
    };
  }

  const events = input.events ?? eventsFromToolResponse(context.events(), input.host.toolResponse);
  const wakeableRecipients = services.delivery.collectWakeableRecipients(events);

  return {
    handled: true,
    wakeableRecipients,
    output: renderSentWakeup(wakeableRecipients)
  };
}

export function isTachikomaRoutingTool(toolName: string | undefined): boolean {
  if (!toolName) {
    return false;
  }

  if (TACHIKOMA_ROUTING_TOOLS.has(toolName)) {
    return true;
  }

  return (
    toolName.startsWith("tachikoma_review_") ||
    toolName.startsWith("mcp__tachikoma__tachikoma_review_")
  );
}

export function eventsFromToolResponse(
  events: EventEnvelope[],
  response: unknown
): EventEnvelope[] {
  const fields = collectResponseFields(response);
  const matched = events.filter((event) => {
    if (fields.eventIds.has(event.id)) {
      return true;
    }

    if (event.target.messageId && fields.messageIds.has(event.target.messageId)) {
      return true;
    }

    return Boolean(
      event.target.conversationId && fields.conversationIds.has(event.target.conversationId)
    );
  });

  return matched.filter((event) => WAKEABLE_SOURCE_TYPES.has(event.type));
}

function renderSentWakeup(wakeableRecipients: WakeableRecipient[]): string {
  if (wakeableRecipients.length === 0) {
    return "";
  }

  return JSON.stringify({
    wakeableRecipients: wakeableRecipients.map((recipient) => ({
      inboxItemId: recipient.inboxItemId,
      sourceEventId: recipient.sourceEventId,
      sourceEventType: recipient.sourceEventType,
      reason: recipient.reason,
      messageId: recipient.messageId,
      conversationId: recipient.conversationId,
      target: recipient.target,
      sessionIds: recipient.sessionIds
    }))
  });
}

interface ResponseFields {
  eventIds: Set<string>;
  messageIds: Set<string>;
  conversationIds: Set<string>;
}

function collectResponseFields(response: unknown): ResponseFields {
  const fields: ResponseFields = {
    eventIds: new Set(),
    messageIds: new Set(),
    conversationIds: new Set()
  };

  collectFields(response, fields, new Set());
  return fields;
}

function collectFields(value: unknown, fields: ResponseFields, seen: Set<unknown>): void {
  const parsed = parseJsonLike(value);

  if (parsed !== value) {
    collectFields(parsed, fields, seen);
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectFields(item, fields, seen);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    collectNamedValue(key, nested, fields);
    collectFields(nested, fields, seen);
  }
}

function collectNamedValue(key: string, value: unknown, fields: ResponseFields): void {
  const values = Array.isArray(value) ? value : [value];

  for (const item of values) {
    if (typeof item !== "string" || item.length === 0) {
      continue;
    }

    switch (key) {
      case "eventId":
      case "eventIds":
      case "route":
        fields.eventIds.add(item);
        break;
      case "messageId":
      case "messageIds":
      case "message":
        fields.messageIds.add(item);
        break;
      case "conversationId":
      case "conversationIds":
      case "conversation":
        fields.conversationIds.add(item);
        break;
    }
  }
}

function parseJsonLike(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
