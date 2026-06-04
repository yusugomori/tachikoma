import type { AgentRuntime } from "../domain/types.js";
import {
  type AgentsProjectionState,
  endpointByName,
  liveSessionsForEndpoint
} from "../projections/index.js";

export function nextRuntimeAgentName(state: AgentsProjectionState, runtime: AgentRuntime): string {
  for (let index = 1; index < 1000; index += 1) {
    const name = `${runtime}-${index.toString().padStart(2, "0")}`;
    const endpoint = endpointByName(state, name);

    if (!endpoint) {
      return name;
    }

    if (endpoint.runtime !== runtime) {
      continue;
    }

    if (liveSessionsForEndpoint(state, endpoint).length === 0) {
      return name;
    }
  }

  throw new Error(`Unable to allocate an available ${runtime}-NN agent name.`);
}
