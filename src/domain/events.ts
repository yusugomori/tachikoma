import { z } from "zod";

import { createId } from "./ids.js";
import {
  agentRoleSchema,
  agentRuntimeSchema,
  conversationParticipantSchema,
  deliveryModeSchema,
  deliveryOutcomeSchema,
  isoDateTimeSchema,
  linkedRecordSchema,
  replyPolicySchema,
  routingTargetSchema,
  verificationStatusSchema
} from "./schemas.js";

export const eventTypeSchema = z.enum([
  "project.initialized",
  "agent.endpoint_registered",
  "agent.presence_announced",
  "agent.presence_expired",
  "session.started",
  "session.ended",
  "task.created",
  "task.status_changed",
  "assignment.created",
  "assignment.status_changed",
  "inbox.item_claimed",
  "inbox.item_dismissed",
  "delivery.attempted",
  "delivery.delivered",
  "delivery.failed",
  "message.sent",
  "message.read",
  "conversation.opened",
  "conversation.message_routed",
  "conversation.closed",
  "decision.recorded",
  "knowledge.recorded",
  "implementation.claim_recorded",
  "review.requested",
  "review.finding_recorded",
  "review.finding_addressed",
  "review.finding_accepted",
  "review.finding_reopened",
  "review.approved",
  "verification.recorded",
  "handoff.generated",
  "report.exported"
]);

export const eventActorSchema = z.object({
  agentId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  runtime: agentRuntimeSchema.optional(),
  role: agentRoleSchema.optional(),
  name: z.string().min(1).optional()
});

export const eventTargetSchema = z.object({
  agentId: z.string().min(1).optional(),
  assignmentId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  decisionId: z.string().min(1).optional(),
  handoffId: z.string().min(1).optional(),
  inboxItemId: z.string().min(1).optional(),
  knowledgeId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  presenceId: z.string().min(1).optional(),
  reportId: z.string().min(1).optional(),
  deliveryAttemptId: z.string().min(1).optional(),
  implementationClaimId: z.string().min(1).optional(),
  reviewFindingId: z.string().min(1).optional(),
  reviewRequestId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  verificationId: z.string().min(1).optional()
});

const requiredId = z.string().min(1);

const conversationTargetSchema = eventTargetSchema.extend({
  conversationId: requiredId
});

const messageTargetSchema = conversationTargetSchema.extend({
  messageId: requiredId
});

const implementationClaimTargetSchema = eventTargetSchema.extend({
  implementationClaimId: requiredId
});

const reviewRequestTargetSchema = eventTargetSchema.extend({
  reviewRequestId: requiredId
});

const reviewFindingTargetSchema = eventTargetSchema.extend({
  reviewFindingId: requiredId
});

const verificationTargetSchema = eventTargetSchema.extend({
  verificationId: requiredId
});

const inboxItemTargetSchema = eventTargetSchema.extend({
  inboxItemId: requiredId
});

const deliveryAttemptTargetSchema = eventTargetSchema.extend({
  deliveryAttemptId: requiredId,
  inboxItemId: requiredId,
  messageId: requiredId
});

const eventContractSchemas = {
  "conversation.opened": z.object({
    target: conversationTargetSchema,
    payload: z
      .object({
        title: z.string().min(1),
        participants: z.array(conversationParticipantSchema).default([]),
        linkedRecords: z.array(linkedRecordSchema).default([])
      })
      .strict()
  }),
  "message.sent": z.object({
    target: messageTargetSchema,
    payload: z
      .object({
        sender: conversationParticipantSchema,
        recipients: z.array(routingTargetSchema).default([]),
        body: z.string().min(1),
        replyPolicy: replyPolicySchema,
        linkedRecords: z.array(linkedRecordSchema).default([])
      })
      .strict()
  }),
  "conversation.message_routed": z.object({
    target: messageTargetSchema,
    payload: z
      .object({
        recipients: z.array(routingTargetSchema).min(1),
        inboxItemIds: z.array(requiredId).default([])
      })
      .strict()
  }),
  "implementation.claim_recorded": z.object({
    target: implementationClaimTargetSchema,
    payload: z
      .object({
        summary: z.string().min(1),
        files: z.array(z.string().min(1)).default([]),
        addressedFindingIds: z.array(z.string().min(1)).default([]),
        verificationExpectation: z.string().min(1).optional()
      })
      .strict()
  }),
  "review.requested": z.object({
    target: reviewRequestTargetSchema,
    payload: z
      .object({
        reviewer: routingTargetSchema,
        scope: z.string().min(1)
      })
      .strict()
  }),
  "review.finding_recorded": z.object({
    target: reviewFindingTargetSchema,
    payload: z
      .object({
        summary: z.string().min(1)
      })
      .strict()
  }),
  "verification.recorded": z.object({
    target: verificationTargetSchema,
    payload: z
      .object({
        status: verificationStatusSchema,
        summary: z.string().min(1),
        command: z.string().min(1).optional()
      })
      .strict()
  }),
  "inbox.item_claimed": z.object({
    target: inboxItemTargetSchema,
    payload: z
      .object({
        sessionId: z.string().min(1)
      })
      .strict()
  }),
  "inbox.item_dismissed": z.object({
    target: inboxItemTargetSchema,
    payload: z
      .object({
        reason: z.string().min(1).optional()
      })
      .strict()
  }),
  "delivery.attempted": z.object({
    target: deliveryAttemptTargetSchema,
    payload: z
      .object({
        deliveryMode: deliveryModeSchema,
        recipient: routingTargetSchema
      })
      .strict()
  }),
  "delivery.delivered": z.object({
    target: deliveryAttemptTargetSchema,
    payload: z
      .object({
        deliveryMode: deliveryModeSchema,
        recipient: routingTargetSchema,
        outcome: deliveryOutcomeSchema.optional()
      })
      .strict()
  }),
  "delivery.failed": z.object({
    target: deliveryAttemptTargetSchema,
    payload: z
      .object({
        deliveryMode: deliveryModeSchema,
        recipient: routingTargetSchema,
        error: z.string().min(1)
      })
      .strict()
  })
} as const;

const eventEnvelopeBaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  type: eventTypeSchema,
  schemaVersion: z.number().int().positive(),
  actor: eventActorSchema.default({}),
  target: eventTargetSchema.default({}),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateTimeSchema
});

export const eventEnvelopeSchema = eventEnvelopeBaseSchema.superRefine((event, context) => {
  validateEventContract(event, context);
});

const createEventInputSchema = eventEnvelopeBaseSchema
  .omit({
    id: true,
    createdAt: true,
    schemaVersion: true
  })
  .extend({
    id: z.string().min(1).optional(),
    createdAt: isoDateTimeSchema.optional(),
    schemaVersion: z.number().int().positive().default(1)
  })
  .superRefine((event, context) => {
    validateEventContract(event, context);
  });

export type EventType = z.infer<typeof eventTypeSchema>;
export type EventActor = z.infer<typeof eventActorSchema>;
export type EventTarget = z.infer<typeof eventTargetSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type CreateEventInput = z.input<typeof createEventInputSchema>;

interface EventContractSubject {
  type: EventType;
  target: unknown;
  payload: unknown;
}

function validateEventContract(event: EventContractSubject, context: z.RefinementCtx): void {
  const contract = eventContractSchemas[event.type as keyof typeof eventContractSchemas];

  if (!contract) {
    return;
  }

  const result = contract.safeParse({
    target: event.target,
    payload: event.payload
  });

  if (!result.success) {
    context.addIssue({
      code: "custom",
      message: `Invalid contract for ${event.type}: ${result.error.message}`,
      path: []
    });
  }
}

export function createEvent(
  input: CreateEventInput,
  now = new Date().toISOString()
): EventEnvelope {
  const parsed = createEventInputSchema.parse(input);

  return eventEnvelopeSchema.parse({
    id: parsed.id ?? createId("evt"),
    projectId: parsed.projectId,
    type: parsed.type,
    schemaVersion: parsed.schemaVersion,
    actor: parsed.actor,
    target: parsed.target,
    payload: parsed.payload,
    createdAt: parsed.createdAt ?? now
  });
}
