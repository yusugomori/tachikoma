import { z } from "zod";

import type { EventEnvelope } from "../domain/events.js";
import type { ServiceContext } from "./context.js";
import { parseCommandInput } from "./validation.js";

const recordKnowledgeInputSchema = z.object({
  id: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  tags: z.array(z.string().min(1)).default([])
});

export type RecordKnowledgeInput = z.input<typeof recordKnowledgeInputSchema>;

export class KnowledgeService {
  public constructor(private readonly context: ServiceContext) {}

  public record(input: RecordKnowledgeInput): EventEnvelope {
    const parsed = parseCommandInput(recordKnowledgeInputSchema, input);
    const knowledgeId = parsed.id ?? this.context.id("kn");

    return this.context.appendEvent({
      type: "knowledge.recorded",
      target: {
        knowledgeId,
        taskId: parsed.taskId
      },
      payload: {
        title: parsed.title,
        body: parsed.body,
        tags: parsed.tags
      }
    });
  }
}
