import { z } from "zod";

import type { EventEnvelope } from "../domain/events.js";
import { verificationStatusSchema } from "../domain/schemas.js";
import type { ServiceContext, ServiceEventInput } from "./context.js";
import { actorToParticipant } from "./participants.js";
import { RoutingService } from "./routing-service.js";
import { parseCommandInput } from "./validation.js";

const recordVerificationInputSchema = z.object({
  id: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  implementationClaimId: z.string().min(1).optional(),
  reviewFindingId: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  status: verificationStatusSchema,
  summary: z.string().min(1),
  notifyOnFailure: z.boolean().default(true)
});

export type RecordVerificationInput = z.input<typeof recordVerificationInputSchema>;

export class VerificationService {
  private readonly routing: RoutingService;

  public constructor(private readonly context: ServiceContext) {
    this.routing = new RoutingService(context);
  }

  public record(input: RecordVerificationInput): EventEnvelope[] {
    const parsed = parseCommandInput(recordVerificationInputSchema, input);
    const verificationId = parsed.id ?? this.context.id("vr");
    const events: ServiceEventInput[] = [
      {
        type: "verification.recorded",
        target: {
          verificationId,
          taskId: parsed.taskId,
          conversationId: parsed.conversationId,
          implementationClaimId: parsed.implementationClaimId,
          reviewFindingId: parsed.reviewFindingId
        },
        payload: {
          status: parsed.status,
          summary: parsed.summary,
          command: parsed.command
        }
      }
    ];

    if (parsed.status === "failed" && parsed.notifyOnFailure && parsed.conversationId) {
      const target = this.routing.assertRoutable({ kind: "role", role: "implementer" });
      events.push({
        type: "message.sent",
        target: {
          conversationId: parsed.conversationId,
          messageId: this.context.id("msg")
        },
        payload: {
          sender: actorToParticipant(this.context.actor),
          recipients: [target],
          body: parsed.summary,
          replyPolicy: "required",
          linkedRecords: [
            {
              kind: "verification_result",
              id: verificationId
            }
          ]
        }
      });
    }

    return this.context.appendEvents(events);
  }
}
