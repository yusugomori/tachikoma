import { z } from "zod";

import type { EventEnvelope } from "../domain/events.js";
import { routingTargetSchema } from "../domain/schemas.js";
import type { ServiceContext, ServiceEventInput } from "./context.js";
import { actorToParticipant, routingTargetToParticipant } from "./participants.js";
import { RoutingService, type RoutingTargetInput } from "./routing-service.js";
import { parseCommandInput } from "./validation.js";

const requestReviewInputSchema = z.object({
  id: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  implementationClaimId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  reviewer: z.union([z.string().min(1), routingTargetSchema]),
  scope: z.string().min(1)
});

const recordFindingInputSchema = z.object({
  id: z.string().min(1).optional(),
  reviewRequestId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  implementationClaimId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  summary: z.string().min(1),
  assignee: z.union([z.string().min(1), routingTargetSchema]).optional()
});

const findingLifecycleInputSchema = z.object({
  reviewFindingId: z.string().min(1),
  reviewRequestId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  implementationClaimId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  reviewer: z.union([z.string().min(1), routingTargetSchema]).optional()
});

const approveReviewInputSchema = z.object({
  reviewRequestId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  implementationClaimId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  summary: z.string().min(1).optional()
});

export type RequestReviewInput = z.input<typeof requestReviewInputSchema>;
export type RecordFindingInput = z.input<typeof recordFindingInputSchema>;
export type FindingLifecycleInput = z.input<typeof findingLifecycleInputSchema>;
export type ApproveReviewInput = z.input<typeof approveReviewInputSchema>;

export class ReviewService {
  private readonly routing: RoutingService;

  public constructor(private readonly context: ServiceContext) {
    this.routing = new RoutingService(context);
  }

  public requestReview(input: RequestReviewInput): EventEnvelope[] {
    const parsed = parseCommandInput(requestReviewInputSchema, input);
    const reviewer = this.routing.assertRoutable(parsed.reviewer as RoutingTargetInput);
    const requestId = parsed.id ?? this.context.id("request");
    const conversationId = parsed.conversationId ?? this.context.id("conv");
    const sender = actorToParticipant(this.context.actor);

    return this.context.appendEvents([
      {
        type: "conversation.opened",
        target: {
          conversationId
        },
        payload: {
          title: parsed.scope,
          participants: [sender, routingTargetToParticipant(reviewer)].filter(Boolean),
          linkedRecords: [
            {
              kind: "review_request",
              id: requestId
            }
          ]
        }
      },
      {
        type: "review.requested",
        target: {
          reviewRequestId: requestId,
          implementationClaimId: parsed.implementationClaimId,
          taskId: parsed.taskId,
          conversationId
        },
        payload: {
          reviewer,
          scope: parsed.scope
        }
      },
      {
        type: "message.sent",
        target: {
          conversationId,
          messageId: this.context.id("msg")
        },
        payload: {
          sender,
          recipients: [reviewer],
          body: parsed.scope,
          replyPolicy: "required",
          linkedRecords: [
            {
              kind: "review_request",
              id: requestId
            }
          ]
        }
      }
    ]);
  }

  public recordFinding(input: RecordFindingInput): EventEnvelope[] {
    const parsed = parseCommandInput(recordFindingInputSchema, input);
    const findingId = parsed.id ?? this.context.id("finding");
    const assignee = this.routing.assertRoutable(
      parsed.assignee ?? { kind: "role", role: "implementer" }
    );
    const events: ServiceEventInput[] = [
      {
        type: "review.finding_recorded",
        target: {
          reviewFindingId: findingId,
          reviewRequestId: parsed.reviewRequestId,
          implementationClaimId: parsed.implementationClaimId,
          taskId: parsed.taskId,
          conversationId: parsed.conversationId
        },
        payload: {
          summary: parsed.summary
        }
      }
    ];

    if (parsed.conversationId) {
      events.push({
        type: "message.sent",
        target: {
          conversationId: parsed.conversationId,
          messageId: this.context.id("msg")
        },
        payload: {
          sender: actorToParticipant(this.context.actor),
          recipients: [assignee],
          body: parsed.summary,
          replyPolicy: "required",
          linkedRecords: [
            {
              kind: "review_finding",
              id: findingId
            }
          ]
        }
      });
    }

    return this.context.appendEvents(events);
  }

  public addressFinding(input: FindingLifecycleInput): EventEnvelope[] {
    const parsed = parseCommandInput(findingLifecycleInputSchema, input);
    const reviewer = parsed.reviewer
      ? this.routing.assertRoutable(parsed.reviewer as RoutingTargetInput)
      : this.routing.assertRoutable({ kind: "role", role: "reviewer" });
    const events: ServiceEventInput[] = [
      lifecycleEvent("review.finding_addressed", parsed, parsed.reviewFindingId)
    ];

    if (parsed.conversationId) {
      events.push({
        type: "message.sent",
        target: {
          conversationId: parsed.conversationId,
          messageId: this.context.id("msg")
        },
        payload: {
          sender: actorToParticipant(this.context.actor),
          recipients: [reviewer],
          body: parsed.summary ?? `Finding ${parsed.reviewFindingId} addressed.`,
          replyPolicy: "required",
          linkedRecords: [
            {
              kind: "review_finding",
              id: parsed.reviewFindingId
            }
          ]
        }
      });
    }

    return this.context.appendEvents(events);
  }

  public acceptFinding(input: FindingLifecycleInput): EventEnvelope {
    const parsed = parseCommandInput(findingLifecycleInputSchema, input);
    return this.context.appendEvent(
      lifecycleEvent("review.finding_accepted", parsed, parsed.reviewFindingId)
    );
  }

  public reopenFinding(input: FindingLifecycleInput): EventEnvelope {
    const parsed = parseCommandInput(findingLifecycleInputSchema, input);
    return this.context.appendEvent(
      lifecycleEvent("review.finding_reopened", parsed, parsed.reviewFindingId)
    );
  }

  public approveReview(input: ApproveReviewInput): EventEnvelope {
    const parsed = parseCommandInput(approveReviewInputSchema, input);

    return this.context.appendEvent({
      type: "review.approved",
      target: {
        reviewRequestId: parsed.reviewRequestId,
        implementationClaimId: parsed.implementationClaimId,
        taskId: parsed.taskId,
        conversationId: parsed.conversationId
      },
      payload: {
        summary: parsed.summary
      }
    });
  }
}

function lifecycleEvent(
  type: "review.finding_addressed" | "review.finding_accepted" | "review.finding_reopened",
  parsed: z.output<typeof findingLifecycleInputSchema>,
  reviewFindingId: string
): ServiceEventInput {
  return {
    type,
    target: {
      reviewFindingId,
      reviewRequestId: parsed.reviewRequestId,
      implementationClaimId: parsed.implementationClaimId,
      taskId: parsed.taskId,
      conversationId: parsed.conversationId
    },
    payload: {
      summary: parsed.summary
    }
  };
}
