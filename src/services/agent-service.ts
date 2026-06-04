import { z } from "zod";

import type { EventEnvelope } from "../domain/events.js";
import { agentRoleSchema, agentRuntimeSchema } from "../domain/schemas.js";
import type { ServiceContext } from "./context.js";
import { parseCommandInput } from "./validation.js";

const registerAgentInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  runtime: agentRuntimeSchema,
  role: agentRoleSchema.optional()
});

export type RegisterAgentInput = z.input<typeof registerAgentInputSchema>;

export class AgentService {
  public constructor(private readonly context: ServiceContext) {}

  public registerEndpoint(input: RegisterAgentInput): EventEnvelope {
    const parsed = parseCommandInput(registerAgentInputSchema, input);
    const agentId = parsed.id ?? this.context.id("agent");

    return this.context.appendEvent({
      type: "agent.endpoint_registered",
      target: {
        agentId
      },
      payload: {
        name: parsed.name,
        runtime: parsed.runtime,
        ...(parsed.role ? { role: parsed.role } : {})
      }
    });
  }
}
