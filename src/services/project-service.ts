import { z } from "zod";

import type { EventEnvelope } from "../domain/events.js";
import type { ServiceContext } from "./context.js";
import { parseCommandInput } from "./validation.js";

const initializeProjectInputSchema = z.object({
  name: z.string().min(1),
  repoRoot: z.string().min(1).optional()
});

export type InitializeProjectInput = z.input<typeof initializeProjectInputSchema>;

export class ProjectService {
  public constructor(private readonly context: ServiceContext) {}

  public initialize(input: InitializeProjectInput): EventEnvelope {
    const parsed = parseCommandInput(initializeProjectInputSchema, input);

    return this.context.appendEvent({
      type: "project.initialized",
      payload: parsed
    });
  }
}
