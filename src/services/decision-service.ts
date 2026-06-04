import { z } from "zod";

import type { EventEnvelope } from "../domain/events.js";
import { decisionStatusSchema } from "../domain/schemas.js";
import type { ServiceContext } from "./context.js";
import { parseCommandInput } from "./validation.js";

const recordDecisionInputSchema = z.object({
  id: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  summary: z.string().min(1),
  rationale: z.string().min(1),
  status: decisionStatusSchema.default("accepted")
});

export type RecordDecisionInput = z.input<typeof recordDecisionInputSchema>;

export class DecisionService {
  public constructor(private readonly context: ServiceContext) {}

  public record(input: RecordDecisionInput): EventEnvelope {
    const parsed = parseCommandInput(recordDecisionInputSchema, input);
    const decisionId = parsed.id ?? this.context.id("dec");

    return this.context.appendEvent({
      type: "decision.recorded",
      target: {
        decisionId,
        taskId: parsed.taskId
      },
      payload: {
        summary: parsed.summary,
        rationale: parsed.rationale,
        status: parsed.status
      }
    });
  }
}
