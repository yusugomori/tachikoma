import { z } from "zod";

import type { EventEnvelope } from "../domain/events.js";
import {
  createProjectSnapshot,
  type ProjectSnapshot,
  renderHandoffMarkdown
} from "../exports/index.js";
import type { ServiceContext } from "./context.js";
import { parseCommandInput } from "./validation.js";

const generateHandoffInputSchema = z.object({
  id: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  summary: z.string().min(1)
});

export type GenerateHandoffInput = z.input<typeof generateHandoffInputSchema>;

export interface RenderedHandoff {
  format: "markdown";
  content: string;
  snapshot: ProjectSnapshot;
}

export class HandoffService {
  public constructor(private readonly context: ServiceContext) {}

  public render(input: GenerateHandoffInput): RenderedHandoff {
    const parsed = parseCommandInput(generateHandoffInputSchema, input);
    const snapshot = createProjectSnapshot({
      projections: this.context.projections(),
      events: this.context.events(),
      generatedAt: this.context.now()
    });

    return {
      format: "markdown",
      snapshot,
      content: renderHandoffMarkdown({
        snapshot,
        summary: parsed.summary,
        taskId: parsed.taskId
      })
    };
  }

  public generate(input: GenerateHandoffInput): EventEnvelope {
    const parsed = parseCommandInput(generateHandoffInputSchema, input);
    const handoffId = parsed.id ?? this.context.id("handoff");

    return this.context.appendEvent({
      type: "handoff.generated",
      target: {
        handoffId,
        taskId: parsed.taskId
      },
      payload: {
        summary: parsed.summary
      }
    });
  }
}
