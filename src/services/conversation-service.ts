import { z } from "zod";

import { ValidationError } from "../domain/errors.js";
import {
  conversationParticipantSchema,
  linkedRecordSchema,
  replyPolicySchema,
  routingTargetSchema
} from "../domain/schemas.js";
import type { ConversationParticipant, LinkedRecord, RoutingTarget } from "../domain/types.js";
import {
  type ConversationsProjectionState,
  getInboxForAgentName,
  messagesForThread,
  routingTargetKey
} from "../projections/index.js";
import type { ServiceContext, ServiceEventInput } from "./context.js";
import {
  actorToParticipant,
  participantToRoutingTarget,
  routingTargetToParticipant,
  sameParticipant
} from "./participants.js";
import { RoutingService, type RoutingTargetInput } from "./routing-service.js";
import { parseCommandInput } from "./validation.js";

const openThreadInputSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  participants: z.array(conversationParticipantSchema).default([]),
  linkedRecords: z.array(linkedRecordSchema).default([])
});

const askInputSchema = z.object({
  conversationId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  assignmentId: z.string().min(1).optional(),
  target: z.union([z.string().min(1), routingTargetSchema]),
  body: z.string().min(1),
  title: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  replyPolicy: replyPolicySchema.default("required"),
  linkedRecords: z.array(linkedRecordSchema).default([])
});

const replyInputSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  sender: conversationParticipantSchema.optional(),
  recipients: z.array(z.union([z.string().min(1), routingTargetSchema])).optional(),
  body: z.string().min(1),
  replyPolicy: replyPolicySchema.default("none"),
  linkedRecords: z.array(linkedRecordSchema).default([])
});

const routeStructuredEventInputSchema = z.object({
  conversationId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  title: z.string().min(1),
  target: z.union([z.string().min(1), routingTargetSchema]),
  body: z.string().min(1),
  replyPolicy: replyPolicySchema.default("none"),
  linkedRecords: z.array(linkedRecordSchema).default([])
});

const closeThreadInputSchema = z.object({
  conversationId: z.string().min(1),
  reason: z.string().min(1).optional()
});

export type OpenThreadInput = z.input<typeof openThreadInputSchema>;
export type AskInput = z.input<typeof askInputSchema>;
export type ReplyInput = z.input<typeof replyInputSchema>;
export type RouteStructuredEventInput = z.input<typeof routeStructuredEventInputSchema>;
export type CloseThreadInput = z.input<typeof closeThreadInputSchema>;

export class ConversationService {
  private readonly routing: RoutingService;

  public constructor(private readonly context: ServiceContext) {
    this.routing = new RoutingService(context);
  }

  public openThread(input: OpenThreadInput) {
    const parsed = parseCommandInput(openThreadInputSchema, input);
    const conversationId = parsed.id ?? this.context.id("conv");

    return this.context.appendEvent({
      type: "conversation.opened",
      target: {
        conversationId
      },
      payload: {
        title: parsed.title,
        participants: parsed.participants,
        linkedRecords: parsed.linkedRecords
      }
    });
  }

  public ask(input: AskInput) {
    const parsed = parseCommandInput(askInputSchema, input);
    const target = this.routing.assertRoutable(parsed.target as RoutingTargetInput);
    const conversationId = parsed.conversationId ?? this.context.id("conv");
    const messageId = parsed.messageId ?? this.context.id("msg");
    const assignmentId = parsed.assignmentId ?? this.context.id("assign");
    const sender = actorToParticipant(this.context.actor);
    const participants = compactParticipants([sender, routingTargetToParticipant(target)]);
    const linkedRecords = compactLinkedRecords([
      ...parsed.linkedRecords,
      { kind: "assignment", id: assignmentId },
      linkedRecord("task", parsed.taskId)
    ]);

    return this.context.appendEvents([
      {
        type: "conversation.opened",
        target: {
          conversationId
        },
        payload: {
          title: parsed.title ?? parsed.body,
          participants,
          linkedRecords
        }
      },
      {
        type: "message.sent",
        target: {
          conversationId,
          messageId
        },
        payload: {
          sender,
          recipients: [target],
          body: parsed.body,
          replyPolicy: parsed.replyPolicy,
          linkedRecords
        }
      },
      {
        type: "assignment.created",
        target: {
          assignmentId,
          taskId: parsed.taskId,
          conversationId
        },
        payload: {
          target,
          scope: parsed.scope ?? parsed.body,
          status: "queued"
        }
      }
    ]);
  }

  public replyToThread(input: ReplyInput) {
    const parsed = parseCommandInput(replyInputSchema, input);
    const projections = this.context.projections();
    const thread = projections.conversations.threads.find(
      (candidate) => candidate.id === parsed.conversationId
    );

    if (!thread) {
      throw new ValidationError(`Conversation ${parsed.conversationId} was not found.`);
    }

    const sender = parsed.sender ?? actorToParticipant(this.context.actor);
    const recipients = parsed.recipients
      ? parsed.recipients.map((recipient) =>
          this.routing.assertRoutable(recipient as RoutingTargetInput)
        )
      : inferReplyRecipients(projections.conversations, parsed.conversationId, sender);

    const messageId = parsed.messageId ?? this.context.id("msg");
    const messageEventId = this.context.id("evt");
    const inboxItemIds = recipients.map((_, index) => `inbox_${messageEventId}_${index}`);

    const events: ServiceEventInput[] = [
      {
        id: messageEventId,
        type: "message.sent",
        target: {
          conversationId: parsed.conversationId,
          messageId
        },
        payload: {
          sender,
          recipients,
          body: parsed.body,
          replyPolicy: parsed.replyPolicy,
          linkedRecords: parsed.linkedRecords
        }
      }
    ];

    if (recipients.length > 0) {
      events.push({
        type: "conversation.message_routed",
        target: {
          conversationId: parsed.conversationId,
          messageId
        },
        payload: {
          recipients,
          inboxItemIds
        }
      });
    }

    events.push(...readEventsForRepliedInbox(projections, parsed.conversationId, sender));

    return this.context.appendEvents(events);
  }

  public routeStructuredEvent(input: RouteStructuredEventInput) {
    const parsed = parseCommandInput(routeStructuredEventInputSchema, input);
    const target = this.routing.assertRoutable(parsed.target as RoutingTargetInput);
    const conversationId = parsed.conversationId ?? this.context.id("conv");
    const messageId = parsed.messageId ?? this.context.id("msg");
    const sender = actorToParticipant(this.context.actor);
    const shouldOpen = !this.context
      .projections()
      .conversations.threads.some((thread) => thread.id === conversationId);
    const events: ServiceEventInput[] = [];

    if (shouldOpen) {
      events.push({
        type: "conversation.opened",
        target: {
          conversationId
        },
        payload: {
          title: parsed.title,
          participants: compactParticipants([sender, routingTargetToParticipant(target)]),
          linkedRecords: parsed.linkedRecords
        }
      });
    }

    events.push({
      type: "message.sent",
      target: {
        conversationId,
        messageId
      },
      payload: {
        sender,
        recipients: [target],
        body: parsed.body,
        replyPolicy: parsed.replyPolicy,
        linkedRecords: parsed.linkedRecords
      }
    });

    return this.context.appendEvents(events);
  }

  public closeThread(input: CloseThreadInput) {
    const parsed = parseCommandInput(closeThreadInputSchema, input);

    return this.context.appendEvent({
      type: "conversation.closed",
      target: {
        conversationId: parsed.conversationId
      },
      payload: {
        reason: parsed.reason
      }
    });
  }
}

function inferReplyRecipients(
  conversations: ConversationsProjectionState,
  conversationId: string,
  sender: ConversationParticipant
): RoutingTarget[] {
  const recipients = new Map<string, RoutingTarget>();

  for (const message of messagesForThread(conversations, conversationId)) {
    if (!sameParticipant(message.sender, sender)) {
      const target = participantToRoutingTarget(message.sender);
      if (target) {
        recipients.set(routingTargetKey(target), target);
      }
    }

    for (const recipient of message.recipients) {
      const participant = routingTargetToParticipant(recipient);
      if (participant && !sameParticipant(participant, sender)) {
        recipients.set(routingTargetKey(recipient), recipient);
      }
    }
  }

  return [...recipients.values()];
}

function readEventsForRepliedInbox(
  projections: ReturnType<ServiceContext["projections"]>,
  conversationId: string,
  sender: ConversationParticipant
): ServiceEventInput[] {
  if (sender.kind !== "agent") {
    return [];
  }

  return getInboxForAgentName(projections.inbox, projections.agents, sender.name)
    .filter((item) => item.kind === "message")
    .filter((item) => item.conversationId === conversationId)
    .filter((item) => item.status !== "read" && item.status !== "cancelled")
    .map((item) => ({
      type: "message.read" as const,
      target: {
        inboxItemId: item.id,
        messageId: item.messageId
      },
      payload: {}
    }));
}

function compactParticipants(
  participants: Array<ConversationParticipant | undefined>
): ConversationParticipant[] {
  return participants.filter((participant): participant is ConversationParticipant =>
    Boolean(participant)
  );
}

function linkedRecord(
  kind: LinkedRecord["kind"],
  id: string | undefined
): LinkedRecord | undefined {
  return id ? { kind, id } : undefined;
}

function compactLinkedRecords(records: Array<LinkedRecord | undefined>): LinkedRecord[] {
  return records.filter((record): record is LinkedRecord => Boolean(record));
}
