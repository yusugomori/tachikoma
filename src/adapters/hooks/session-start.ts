import type { AgentRole, AgentRuntime, DeliveryMode } from "../../domain/types.js";
import { endpointByName } from "../../projections/index.js";
import type { ServiceContext, Services } from "../../services/index.js";
import {
  assertRuntimeSupportsDeliveryMode,
  deliveryCapabilitiesForMode
} from "../delivery/types.js";
import { renderSessionStart } from "./render.js";

export interface SessionStartHookInput {
  name?: string;
  agentId?: string;
  runtime?: AgentRuntime;
  role?: AgentRole;
  deliveryMode?: DeliveryMode;
  cwd?: string;
  capabilities?: string[];
  takeover?: boolean;
  monitorCommand?: string;
}

export interface SessionStartHookResult {
  sessionId: string;
  claimedCount: number;
  briefLines: string[];
  output: string;
}

export function runSessionStartHook(
  context: ServiceContext,
  services: Services,
  input: SessionStartHookInput
): SessionStartHookResult {
  const endpoint = input.name
    ? endpointByName(context.projections().agents, input.name)
    : undefined;
  const runtime = input.runtime ?? endpoint?.runtime;
  const deliveryMode = input.deliveryMode ?? "turn";

  if (runtime) {
    assertRuntimeSupportsDeliveryMode(runtime, deliveryMode);
  }

  const capabilities = mergeCapabilities(
    input.capabilities ?? [],
    deliveryCapabilitiesForMode(deliveryMode)
  );
  const sessionId = input.name
    ? services.sessions.join({
        name: input.name,
        runtime: input.runtime,
        role: input.role,
        deliveryMode,
        cwd: input.cwd,
        capabilities,
        takeover: input.takeover
      }).sessionId
    : services.sessions
        .start({
          agentId: input.agentId,
          runtime: input.runtime,
          role: input.role,
          deliveryMode,
          cwd: input.cwd,
          capabilities
        })
        .find((event) => event.type === "session.started")?.target.sessionId;

  if (!sessionId) {
    throw new Error("SessionStart hook did not create a session.");
  }

  const claimed = deliveryMode === "off" ? [] : services.delivery.claimForSession({ sessionId });
  const briefLines = context.projections().brief.lines;

  return {
    sessionId,
    claimedCount: claimed.length,
    briefLines,
    output: renderSessionStart({
      sessionId,
      agentName: input.name ?? endpoint?.name,
      runtime,
      deliveryMode,
      claimedCount: claimed.length,
      briefLines,
      monitorCommand: input.monitorCommand
    })
  };
}

function mergeCapabilities(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}
