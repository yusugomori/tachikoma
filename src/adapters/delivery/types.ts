import type { AgentRuntime, DeliveryMode } from "../../domain/types.js";
import type { DeliverySurface } from "../../services/delivery-service.js";

export interface RuntimeDeliveryCapabilities {
  runtime: AgentRuntime;
  modes: DeliveryMode[];
  surfaces: DeliverySurface[];
}

export const runtimeDeliveryCapabilities: RuntimeDeliveryCapabilities[] = [
  {
    runtime: "codex",
    modes: ["off", "turn", "realtime"],
    surfaces: ["stop", "app-server"]
  },
  {
    runtime: "claude",
    modes: ["off", "turn", "monitor", "both"],
    surfaces: ["stop", "monitor"]
  },
  {
    runtime: "other",
    modes: ["off", "turn"],
    surfaces: ["stop"]
  }
];

export function modesForRuntime(runtime: AgentRuntime): DeliveryMode[] {
  return capabilityForRuntime(runtime).modes;
}

export function surfacesForRuntime(runtime: AgentRuntime): DeliverySurface[] {
  return capabilityForRuntime(runtime).surfaces;
}

export function runtimeSupportsDeliveryMode(runtime: AgentRuntime, mode: DeliveryMode): boolean {
  return modesForRuntime(runtime).includes(mode);
}

export function runtimeSupportsDeliverySurface(
  runtime: AgentRuntime,
  surface: DeliverySurface
): boolean {
  return surfacesForRuntime(runtime).includes(surface);
}

export function assertRuntimeSupportsDeliveryMode(runtime: AgentRuntime, mode: DeliveryMode): void {
  if (!runtimeSupportsDeliveryMode(runtime, mode)) {
    throw new Error(`${runtime} does not support ${mode} delivery.`);
  }
}

export function deliveryCapabilitiesForMode(mode: DeliveryMode): string[] {
  switch (mode) {
    case "off":
      return [];
    case "turn":
      return ["delivery:turn"];
    case "monitor":
      return ["delivery:monitor"];
    case "both":
      return ["delivery:turn", "delivery:monitor"];
    case "realtime":
      return ["delivery:realtime", "delivery:app-server"];
  }
}

function capabilityForRuntime(runtime: AgentRuntime): RuntimeDeliveryCapabilities {
  const capabilities = runtimeDeliveryCapabilities.find(
    (candidate) => candidate.runtime === runtime
  );

  if (!capabilities) {
    throw new Error(`Unsupported runtime: ${runtime}`);
  }

  return capabilities;
}
