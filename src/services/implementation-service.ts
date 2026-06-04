import { z } from "zod";
import type { EventEnvelope } from "../domain/events.js";
import { linkedRecordSchema, routingTargetSchema } from "../domain/schemas.js";
import type { ServiceContext, ServiceEventInput } from "./context.js";
import { actorToParticipant, routingTargetToParticipant } from "./participants.js";
import { RoutingService, type RoutingTargetInput } from "./routing-service.js";
import { parseCommandInput } from "./validation.js";

const requestReviewOptionsSchema = z.union([
  z.boolean(),
  z.object({
    reviewer: z.union([z.string().min(1), routingTargetSchema]).optional(),
    scope: z.string().min(1).optional()
  })
]);

const recordClaimInputSchema = z.object({
  id: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  assignmentId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  summary: z.string().min(1),
  files: z.array(z.string().min(1)).default([]),
  addressedFindingIds: z.array(z.string().min(1)).default([]),
  verificationExpectation: z.string().min(1).optional(),
  linkedRecords: z.array(linkedRecordSchema).default([]),
  requestReview: requestReviewOptionsSchema.default(false)
});

export type RecordClaimInput = z.input<typeof recordClaimInputSchema>;

export class ImplementationService {
  private readonly routing: RoutingService;

  public constructor(private readonly context: ServiceContext) {
    this.routing = new RoutingService(context);
  }

  public recordClaim(input: RecordClaimInput): EventEnvelope[] {
    const parsed = parseCommandInput(recordClaimInputSchema, input);
    const claimId = parsed.id ?? this.context.id("claim");
    const reviewOptions = normalizeReviewOptions(parsed.requestReview);
    const reviewer = reviewOptions
      ? this.routing.assertRoutable(reviewOptions.reviewer ?? { kind: "role", role: "reviewer" })
      : undefined;
    const conversationId =
      parsed.conversationId ?? (reviewOptions ? this.context.id("conv") : undefined);
    const sender = actorToParticipant(this.context.actor);
    const linkedRecords = [
      ...parsed.linkedRecords,
      { kind: "implementation_claim" as const, id: claimId }
    ];
    const events: ServiceEventInput[] = [];

    if (reviewOptions && conversationId && reviewer) {
      events.push({
        type: "conversation.opened",
        target: {
          conversationId
        },
        payload: {
          title: `Review ${claimId}`,
          participants: [sender, routingTargetToParticipant(reviewer)].filter(Boolean),
          linkedRecords
        }
      });
    }

    events.push({
      type: "implementation.claim_recorded",
      target: {
        implementationClaimId: claimId,
        taskId: parsed.taskId,
        assignmentId: parsed.assignmentId,
        conversationId,
        sessionId: parsed.sessionId,
        agentId: parsed.agentId
      },
      payload: {
        summary: parsed.summary,
        files: parsed.files,
        addressedFindingIds: parsed.addressedFindingIds,
        verificationExpectation: parsed.verificationExpectation
      }
    });

    if (reviewOptions && reviewer && conversationId) {
      const requestId = this.context.id("request");
      const messageId = this.context.id("msg");
      const scope = reviewOptions.scope ?? `Review implementation claim ${claimId}.`;

      events.push(
        {
          type: "review.requested",
          target: {
            reviewRequestId: requestId,
            implementationClaimId: claimId,
            taskId: parsed.taskId,
            conversationId
          },
          payload: {
            reviewer,
            scope
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
            recipients: [reviewer],
            body: scope,
            replyPolicy: "required",
            linkedRecords: [
              ...linkedRecords,
              {
                kind: "review_request",
                id: requestId
              }
            ]
          }
        }
      );
    }

    return this.context.appendEvents(events);
  }
}

interface ReviewOptions {
  reviewer?: RoutingTargetInput;
  scope?: string;
}

function normalizeReviewOptions(
  value: z.output<typeof requestReviewOptionsSchema>
): ReviewOptions | undefined {
  if (value === false) {
    return undefined;
  }

  if (value === true) {
    return {};
  }

  return value;
}
