import { z } from "zod";

import { ValidationError } from "../domain/errors.js";
import type { EventEnvelope } from "../domain/events.js";
import {
  conversationParticipantSchema,
  deliveryModeSchema,
  deliveryOutcomeSchema,
  linkedRecordSchema,
  replyPolicySchema,
  routingTargetSchema
} from "../domain/schemas.js";
import type { DeliveryMode, DeliveryOutcome, RoutingTarget } from "../domain/types.js";
import type { ServiceContext } from "./context.js";
import { actorToParticipant } from "./participants.js";
import { RoutingService, type RoutingTargetInput } from "./routing-service.js";
import { parseCommandInput } from "./validation.js";

const sendMessageInputSchema = z.object({
  id: z.string().min(1).optional(),
  conversationId: z.string().min(1),
  sender: conversationParticipantSchema.optional(),
  recipients: z.array(z.union([z.string().min(1), routingTargetSchema])).min(1),
  body: z.string().min(1),
  replyPolicy: replyPolicySchema.default("optional"),
  linkedRecords: z.array(linkedRecordSchema).default([])
});

const claimInboxItemInputSchema = z.object({
  inboxItemId: z.string().min(1),
  sessionId: z.string().min(1)
});

const dismissInboxItemInputSchema = z.object({
  inboxItemId: z.string().min(1),
  reason: z.string().min(1).optional()
});

const markReadInputSchema = z.object({
  inboxItemId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional()
});

const deliveryAttemptInputSchema = z.object({
  id: z.string().min(1).optional(),
  inboxItemId: z.string().min(1),
  messageId: z.string().min(1),
  recipient: routingTargetSchema,
  deliveryMode: deliveryModeSchema
});

const deliveryFinishedInputSchema = deliveryAttemptInputSchema.extend({
  id: z.string().min(1),
  outcome: deliveryOutcomeSchema.optional(),
  error: z.string().min(1).optional()
});

export type SendMessageInput = z.input<typeof sendMessageInputSchema>;
export type ClaimInboxItemInput = z.input<typeof claimInboxItemInputSchema>;
export type DismissInboxItemInput = z.input<typeof dismissInboxItemInputSchema>;
export type MarkReadInput = z.input<typeof markReadInputSchema>;
export type DeliveryAttemptInput = z.input<typeof deliveryAttemptInputSchema>;
export type DeliveryFinishedInput = z.input<typeof deliveryFinishedInputSchema>;

export class MessageService {
  private readonly routing: RoutingService;

  public constructor(private readonly context: ServiceContext) {
    this.routing = new RoutingService(context);
  }

  public send(input: SendMessageInput): EventEnvelope {
    const parsed = parseCommandInput(sendMessageInputSchema, input);
    const recipients = parsed.recipients.map((recipient) =>
      this.routing.assertRoutable(recipient as RoutingTargetInput)
    );
    const messageId = parsed.id ?? this.context.id("msg");

    return this.context.appendEvent({
      type: "message.sent",
      target: {
        conversationId: parsed.conversationId,
        messageId
      },
      payload: {
        sender: parsed.sender ?? actorToParticipant(this.context.actor),
        recipients,
        body: parsed.body,
        replyPolicy: parsed.replyPolicy,
        linkedRecords: parsed.linkedRecords
      }
    });
  }

  public claimInboxItem(input: ClaimInboxItemInput): EventEnvelope {
    const parsed = parseCommandInput(claimInboxItemInputSchema, input);

    return this.context.appendEvent({
      type: "inbox.item_claimed",
      target: {
        inboxItemId: parsed.inboxItemId
      },
      payload: {
        sessionId: parsed.sessionId
      }
    });
  }

  public dismissInboxItem(input: DismissInboxItemInput): EventEnvelope {
    const parsed = parseCommandInput(dismissInboxItemInputSchema, input);

    return this.context.appendEvent({
      type: "inbox.item_dismissed",
      target: {
        inboxItemId: parsed.inboxItemId
      },
      payload: {
        ...(parsed.reason ? { reason: parsed.reason } : {})
      }
    });
  }

  public markRead(input: MarkReadInput): EventEnvelope {
    const parsed = parseCommandInput(markReadInputSchema, input);

    if (!parsed.inboxItemId && !parsed.messageId) {
      throw new ValidationError("markRead requires inboxItemId or messageId.");
    }

    return this.context.appendEvent({
      type: "message.read",
      target: {
        inboxItemId: parsed.inboxItemId,
        messageId: parsed.messageId
      },
      payload: {}
    });
  }

  public recordDeliveryAttempt(input: DeliveryAttemptInput): EventEnvelope {
    const parsed = parseCommandInput(deliveryAttemptInputSchema, input);
    const deliveryAttemptId = parsed.id ?? this.context.id("delivery");

    return this.context.appendEvent({
      type: "delivery.attempted",
      target: deliveryTarget(deliveryAttemptId, parsed.inboxItemId, parsed.messageId),
      payload: deliveryPayload(parsed.recipient, parsed.deliveryMode)
    });
  }

  public recordDeliveryDelivered(input: DeliveryFinishedInput): EventEnvelope {
    const parsed = parseCommandInput(deliveryFinishedInputSchema, input);

    return this.context.appendEvent({
      type: "delivery.delivered",
      target: deliveryTarget(parsed.id, parsed.inboxItemId, parsed.messageId),
      payload: deliveryPayload(parsed.recipient, parsed.deliveryMode, parsed.outcome)
    });
  }

  public recordDeliveryFailed(input: DeliveryFinishedInput): EventEnvelope {
    const parsed = parseCommandInput(deliveryFinishedInputSchema, input);

    return this.context.appendEvent({
      type: "delivery.failed",
      target: deliveryTarget(parsed.id, parsed.inboxItemId, parsed.messageId),
      payload: {
        ...deliveryPayload(parsed.recipient, parsed.deliveryMode),
        error: parsed.error ?? "Delivery failed."
      }
    });
  }
}

function deliveryTarget(deliveryAttemptId: string, inboxItemId: string, messageId: string) {
  return {
    deliveryAttemptId,
    inboxItemId,
    messageId
  };
}

function deliveryPayload(
  recipient: RoutingTarget,
  deliveryMode: DeliveryMode,
  outcome?: DeliveryOutcome
) {
  return {
    deliveryMode,
    recipient,
    ...(outcome ? { outcome } : {})
  };
}
