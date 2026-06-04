import { z } from "zod";

import { ValidationError } from "../domain/errors.js";
import type { EventEnvelope } from "../domain/events.js";
import type {
  AgentEndpoint,
  ConversationParticipant,
  DeliveryMode,
  InboxItemStatus,
  LinkedRecord,
  ReplyPolicy,
  RoutingTarget,
  Session
} from "../domain/types.js";
import {
  type AgentsProjectionState,
  endpointById,
  getInboxForSession,
  type InboxProjectionItem,
  liveSessionsForEndpoint,
  resolveRoutingTarget
} from "../projections/index.js";
import type { ServiceContext } from "./context.js";
import { MessageService } from "./message-service.js";
import { parseCommandInput } from "./validation.js";

export const deliverySurfaceSchema = z.enum(["stop", "monitor", "app-server"]);
export type DeliverySurface = z.infer<typeof deliverySurfaceSchema>;

const sessionSelectorSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    agentName: z.string().min(1).optional()
  })
  .refine((input) => input.sessionId || input.agentName, {
    message: "Delivery requires a session id or agent name."
  });

const collectDeliveryInputSchema = sessionSelectorSchema.extend({
  surface: deliverySurfaceSchema
});

const recordDeliveryInputSchema = collectDeliveryInputSchema.extend({
  markDelivered: z.boolean().default(true),
  maxItems: z.number().int().positive().default(5),
  includeClaimed: z.boolean().default(true)
});

const claimForSessionInputSchema = z.object({
  sessionId: z.string().min(1)
});

export type SessionSelector = z.input<typeof sessionSelectorSchema>;
export type CollectDeliveryInput = z.input<typeof collectDeliveryInputSchema>;
export type RecordDeliveryInput = z.input<typeof recordDeliveryInputSchema>;
export type ReceiveDeliveryInput = z.input<typeof recordDeliveryInputSchema>;
export type ClaimForSessionInput = z.input<typeof claimForSessionInputSchema>;

type ParsedRecordDeliveryInput = z.output<typeof recordDeliveryInputSchema>;

export interface DeliveryDirective {
  inboxItemId: string;
  reason: string;
  status: InboxItemStatus;
  target: RoutingTarget;
  sender?: ConversationParticipant;
  conversationId?: string;
  messageId?: string;
  body?: string;
  replyPolicy: ReplyPolicy;
  linkedRecords: LinkedRecord[];
  createdAt: string;
}

export interface DeliveryBatch {
  surface: DeliverySurface;
  deliveryMode: DeliveryMode;
  supported: boolean;
  skippedReason?: string;
  session: Session;
  endpoint: AgentEndpoint;
  directives: DeliveryDirective[];
  events: EventEnvelope[];
}

export interface WakeableRecipient {
  inboxItemId: string;
  sourceEventId: string;
  sourceEventType: string;
  kind: InboxProjectionItem["kind"];
  reason: string;
  target: RoutingTarget;
  sessionIds: string[];
  conversationId?: string;
  messageId?: string;
}

export class DeliveryService {
  private readonly messages: MessageService;

  public constructor(private readonly context: ServiceContext) {
    this.messages = new MessageService(context);
  }

  public resolveSession(input: SessionSelector): { session: Session; endpoint: AgentEndpoint } {
    const parsed = parseCommandInput(sessionSelectorSchema, input);
    const projections = this.context.projections();
    const session = parsed.sessionId
      ? projections.agents.sessions.find(
          (candidate) => candidate.id === parsed.sessionId && !candidate.endedAt
        )
      : latestSessionForAgentName(
          projections.agents.sessions,
          projections.agents.endpoints,
          parsed.agentName
        );

    if (!session) {
      throw new ValidationError("No active Tachikoma session matched the delivery request.");
    }

    const endpoint = endpointById(projections.agents, session.agentId);

    if (!endpoint) {
      throw new ValidationError(`Session ${session.id} is not linked to a registered agent.`);
    }

    return {
      session,
      endpoint
    };
  }

  public claimForSession(input: ClaimForSessionInput): EventEnvelope[] {
    const parsed = parseCommandInput(claimForSessionInputSchema, input);
    const projections = this.context.projections();
    const claimable = getInboxForSession(
      projections.inbox,
      projections.agents,
      parsed.sessionId
    ).filter((item) => item.status === "queued");

    return claimable.map((item) =>
      this.messages.claimInboxItem({
        inboxItemId: item.id,
        sessionId: parsed.sessionId
      })
    );
  }

  public collectPending(input: CollectDeliveryInput): DeliveryBatch {
    return this.collect(input, isOutstandingMessageItem);
  }

  public collectNotifications(input: CollectDeliveryInput): DeliveryBatch {
    return this.collect(input, isNotificationMessageItem);
  }

  private collect(
    input: CollectDeliveryInput,
    predicate: (item: InboxProjectionItem) => boolean
  ): DeliveryBatch {
    const parsed = parseCommandInput(collectDeliveryInputSchema, input);
    const { session, endpoint } = this.resolveSession(parsed);
    const supported = supportsDeliverySurface(session.deliveryMode, parsed.surface);
    const projections = this.context.projections();

    return {
      surface: parsed.surface,
      deliveryMode: session.deliveryMode,
      supported,
      skippedReason: supported ? undefined : skippedReason(session.deliveryMode, parsed.surface),
      session,
      endpoint,
      directives: supported
        ? getInboxForSession(projections.inbox, projections.agents, session.id)
            .filter(predicate)
            .map(toDirective)
        : [],
      events: []
    };
  }

  public deliverPending(input: RecordDeliveryInput): DeliveryBatch {
    const parsed = parseCommandInput(recordDeliveryInputSchema, input);

    return this.recordDeliveryBatch(this.collectPending(parsed), parsed);
  }

  public deliverNotifications(input: RecordDeliveryInput): DeliveryBatch {
    const parsed = parseCommandInput(recordDeliveryInputSchema, input);

    return this.recordDeliveryBatch(this.collectNotifications(parsed), parsed);
  }

  private recordDeliveryBatch(
    pendingBatch: DeliveryBatch,
    parsed: ParsedRecordDeliveryInput
  ): DeliveryBatch {
    const batch = {
      ...pendingBatch,
      directives: pendingBatch.directives
        .filter((directive) => parsed.includeClaimed || directive.status !== "claimed")
        .slice(0, parsed.maxItems)
    };

    if (!batch.supported || batch.directives.length === 0) {
      return batch;
    }

    const events = batch.directives.flatMap((directive) => {
      if (!directive.messageId) {
        return [];
      }

      const attempts = this.context
        .projections()
        .inbox.deliveryAttempts.filter(
          (attempt) =>
            attempt.inboxItemId === directive.inboxItemId &&
            attempt.messageId === directive.messageId
        );

      if (attempts.some((attempt) => attempt.status === "delivered")) {
        return [];
      }

      const existingAttempt = attempts.find((attempt) => attempt.status === "attempted");
      const attemptId = existingAttempt?.id ?? this.context.id("delivery");
      const attemptEvents = existingAttempt
        ? []
        : [
            this.messages.recordDeliveryAttempt({
              id: attemptId,
              inboxItemId: directive.inboxItemId,
              messageId: directive.messageId,
              recipient: directive.target,
              deliveryMode: batch.deliveryMode
            })
          ];

      if (!parsed.markDelivered) {
        return attemptEvents;
      }

      return [
        ...attemptEvents,
        this.messages.recordDeliveryDelivered({
          id: attemptId,
          inboxItemId: directive.inboxItemId,
          messageId: directive.messageId,
          recipient: directive.target,
          deliveryMode: batch.deliveryMode
        })
      ];
    });

    return {
      ...batch,
      events
    };
  }

  public collectWakeableRecipients(events: EventEnvelope[]): WakeableRecipient[] {
    const sourceEventIds = new Set(events.map((event) => event.id));

    if (sourceEventIds.size === 0) {
      return [];
    }

    const projections = this.context.projections();

    return projections.inbox.items
      .filter((item) => sourceEventIds.has(item.sourceEventId))
      .filter((item) => item.status === "queued")
      .flatMap((item) => {
        const sessionIds = liveSessionIdsForTarget(projections.agents, item.target);

        if (sessionIds.length === 0) {
          return [];
        }

        return [
          {
            inboxItemId: item.id,
            sourceEventId: item.sourceEventId,
            sourceEventType: item.sourceEventType,
            kind: item.kind,
            reason: item.reason,
            target: item.target,
            sessionIds,
            conversationId: item.conversationId,
            messageId: item.messageId
          }
        ];
      });
  }
}

export function supportsDeliverySurface(mode: DeliveryMode, surface: DeliverySurface): boolean {
  if (mode === "off") {
    return false;
  }

  if (surface === "stop") {
    return mode === "turn" || mode === "both";
  }

  if (surface === "monitor") {
    return mode === "monitor" || mode === "both";
  }

  return mode === "realtime";
}

function skippedReason(mode: DeliveryMode, surface: DeliverySurface): string {
  if (mode === "off") {
    return "delivery mode is off";
  }

  return `${mode} delivery does not support ${surface}`;
}

function isOutstandingMessageItem(item: InboxProjectionItem): boolean {
  return (
    item.kind === "message" &&
    Boolean(item.messageId) &&
    (["queued", "claimed", "failed"].includes(item.status) ||
      (item.status === "delivered" && item.replyPolicy === "required"))
  );
}

function isNotificationMessageItem(item: InboxProjectionItem): boolean {
  return (
    item.kind === "message" &&
    Boolean(item.messageId) &&
    ["queued", "claimed", "failed"].includes(item.status)
  );
}

function toDirective(item: InboxProjectionItem): DeliveryDirective {
  return {
    inboxItemId: item.id,
    reason: item.reason,
    status: item.status,
    target: item.target,
    sender: item.sender,
    conversationId: item.conversationId,
    messageId: item.messageId,
    body: item.body,
    replyPolicy: item.replyPolicy ?? "optional",
    linkedRecords: item.linkedRecords,
    createdAt: item.createdAt
  };
}

function liveSessionIdsForTarget(agents: AgentsProjectionState, target: RoutingTarget): string[] {
  const resolution = resolveRoutingTarget(agents, target);

  if (resolution.status === "resolved") {
    if (target.kind === "session") {
      return liveSessionsForEndpoint(agents, resolution.endpoint)
        .map((session) => session.id)
        .filter((sessionId) => sessionId === target.sessionId);
    }

    return uniqueSorted(resolution.liveSessionIds);
  }

  if (resolution.status === "broadcast") {
    return uniqueSorted(
      resolution.endpoints.flatMap((endpoint) =>
        liveSessionsForEndpoint(agents, endpoint).map((session) => session.id)
      )
    );
  }

  return [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function latestSessionForAgentName(
  sessions: Session[],
  endpoints: AgentEndpoint[],
  agentName: string | undefined
): Session | undefined {
  if (!agentName) {
    return undefined;
  }

  const endpoint = endpoints.find((candidate) => candidate.name === agentName);

  if (!endpoint) {
    return undefined;
  }

  return sessions
    .filter((session) => session.agentId === endpoint.id && !session.endedAt)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
}
