import { z } from "zod";

import { ValidationError } from "../domain/errors.js";
import type { EventEnvelope } from "../domain/events.js";
import { agentRoleSchema, agentRuntimeSchema, deliveryModeSchema } from "../domain/schemas.js";
import { endpointByName, liveSessionsForEndpoint } from "../projections/index.js";
import type { ServiceContext, ServiceEventInput } from "./context.js";
import { parseCommandInput } from "./validation.js";

const startSessionInputSchema = z.object({
  id: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  runtime: agentRuntimeSchema.optional(),
  role: agentRoleSchema.optional(),
  deliveryMode: deliveryModeSchema.default("turn"),
  cwd: z.string().min(1).optional(),
  announcePresence: z.boolean().default(true),
  capabilities: z.array(z.string().min(1)).default([])
});

const joinSessionInputSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  runtime: agentRuntimeSchema.optional(),
  role: agentRoleSchema.optional(),
  deliveryMode: deliveryModeSchema.default("turn"),
  cwd: z.string().min(1).optional(),
  announcePresence: z.boolean().default(true),
  capabilities: z.array(z.string().min(1)).default([]),
  takeover: z.boolean().default(false),
  force: z.boolean().default(false)
});

const endSessionInputSchema = z.object({
  sessionId: z.string().min(1)
});

const announcePresenceInputSchema = z.object({
  id: z.string().min(1).optional(),
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  deliveryMode: deliveryModeSchema,
  capabilities: z.array(z.string().min(1)).default([])
});

export type StartSessionInput = z.input<typeof startSessionInputSchema>;
export type JoinSessionInput = z.input<typeof joinSessionInputSchema>;
export type EndSessionInput = z.input<typeof endSessionInputSchema>;
export type AnnouncePresenceInput = z.input<typeof announcePresenceInputSchema>;

export interface JoinSessionResult {
  events: EventEnvelope[];
  agentId: string;
  sessionId: string;
  endpointCreated: boolean;
  endpointUpdated: boolean;
  endedSessionIds: string[];
}

export class SessionService {
  public constructor(private readonly context: ServiceContext) {}

  public start(input: StartSessionInput): EventEnvelope[] {
    const parsed = parseCommandInput(startSessionInputSchema, input);
    const endpoint = parsed.name
      ? endpointByName(this.context.projections().agents, parsed.name)
      : undefined;
    const agentId = parsed.agentId ?? endpoint?.id;
    const runtime = parsed.runtime ?? endpoint?.runtime;
    const role = parsed.role ?? endpoint?.role;
    const sessionId = parsed.id ?? this.context.id("sess");

    if (!agentId || !runtime) {
      throw new ValidationError("Session requires an agent id and runtime.");
    }

    const events: ServiceEventInput[] = [
      {
        type: "session.started" as const,
        target: {
          agentId,
          sessionId
        },
        payload: {
          runtime,
          ...(role ? { role } : {}),
          deliveryMode: parsed.deliveryMode,
          cwd: parsed.cwd
        }
      }
    ];

    if (parsed.announcePresence) {
      events.push({
        type: "agent.presence_announced",
        target: {
          agentId,
          sessionId,
          presenceId: this.context.id("presence")
        },
        payload: {
          deliveryMode: parsed.deliveryMode,
          capabilities: parsed.capabilities
        }
      });
    }

    return this.context.appendEvents(events);
  }

  public join(input: JoinSessionInput): JoinSessionResult {
    const parsed = parseCommandInput(joinSessionInputSchema, input);
    const projections = this.context.projections();
    const endpoint = endpointByName(projections.agents, parsed.name);
    const runtime = parsed.runtime ?? endpoint?.runtime;
    const role = parsed.role ?? endpoint?.role;

    if (!runtime) {
      throw new ValidationError("Join requires a runtime when the agent name is new.");
    }

    const runtimeChanged = Boolean(
      endpoint && parsed.runtime && parsed.runtime !== endpoint.runtime
    );
    const roleChanged = Boolean(endpoint && parsed.role && parsed.role !== endpoint.role);

    if ((runtimeChanged || roleChanged) && !parsed.force) {
      throw new ValidationError(
        `Agent ${parsed.name} is already registered as runtime=${endpoint?.runtime} role=${endpoint?.role}. Use --force to update it.`
      );
    }

    const liveSessions = endpoint ? liveSessionsForEndpoint(projections.agents, endpoint) : [];

    if (liveSessions.length > 0 && !parsed.takeover) {
      throw new ValidationError(
        `Agent ${parsed.name} already has a live session. Use --takeover to replace it.`
      );
    }

    const agentId = endpoint?.id ?? this.context.id("agent");
    const sessionId = parsed.id ?? this.context.id("sess");
    const events: ServiceEventInput[] = [];

    if (!endpoint || runtimeChanged || roleChanged) {
      events.push({
        type: "agent.endpoint_registered" as const,
        target: {
          agentId
        },
        payload: {
          name: parsed.name,
          runtime,
          ...(role ? { role } : {})
        }
      });
    }

    if (parsed.takeover) {
      for (const session of liveSessions) {
        events.push(
          {
            type: "session.ended" as const,
            target: {
              agentId,
              sessionId: session.id
            },
            payload: {}
          },
          {
            type: "agent.presence_expired" as const,
            target: {
              agentId,
              sessionId: session.id
            },
            payload: {}
          }
        );
      }
    }

    events.push({
      type: "session.started" as const,
      target: {
        agentId,
        sessionId
      },
      payload: {
        runtime,
        ...(role ? { role } : {}),
        deliveryMode: parsed.deliveryMode,
        cwd: parsed.cwd
      }
    });

    if (parsed.announcePresence) {
      events.push({
        type: "agent.presence_announced" as const,
        target: {
          agentId,
          sessionId,
          presenceId: this.context.id("presence")
        },
        payload: {
          deliveryMode: parsed.deliveryMode,
          capabilities: parsed.capabilities
        }
      });
    }

    return {
      events: this.context.appendEvents(events),
      agentId,
      sessionId,
      endpointCreated: !endpoint,
      endpointUpdated: runtimeChanged || roleChanged,
      endedSessionIds: liveSessions.map((session) => session.id)
    };
  }

  public end(input: EndSessionInput): EventEnvelope {
    const parsed = parseCommandInput(endSessionInputSchema, input);

    return this.context.appendEvent({
      type: "session.ended",
      target: {
        sessionId: parsed.sessionId
      },
      payload: {}
    });
  }

  public announcePresence(input: AnnouncePresenceInput): EventEnvelope {
    const parsed = parseCommandInput(announcePresenceInputSchema, input);

    return this.context.appendEvent({
      type: "agent.presence_announced",
      target: {
        agentId: parsed.agentId,
        sessionId: parsed.sessionId,
        presenceId: parsed.id ?? this.context.id("presence")
      },
      payload: {
        deliveryMode: parsed.deliveryMode,
        capabilities: parsed.capabilities
      }
    });
  }
}
