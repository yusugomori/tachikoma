import type { Command } from "commander";

import { deliveryCapabilitiesForMode } from "../../adapters/index.js";
import type { AgentRole, AgentRuntime, DeliveryMode } from "../../domain/types.js";
import { endpointByName } from "../../projections/index.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface JoinOptions {
  runtime?: AgentRuntime;
  role?: AgentRole;
  deliveryMode?: DeliveryMode;
  presence?: boolean;
  capability?: string[];
  takeover?: boolean;
  force?: boolean;
}

export function registerJoinCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("join <name>")
    .description("Name this running agent session and claim pending inbox work.")
    .option("--runtime <runtime>", "Agent runtime: codex, claude, or other.")
    .option("--role <role>", "Optional project-local routing label.")
    .option("--delivery-mode <mode>", "Delivery mode.", "turn")
    .option("--no-presence", "Join without announcing presence.")
    .option("--capability <capability>", "Presence capability.", collect, [])
    .option("--takeover", "End existing live sessions for this name before joining.")
    .option("--force", "Update runtime or role for an existing named endpoint.")
    .action(async function (this: Command, name: string, options: JoinOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const deliveryMode = options.deliveryMode ?? "turn";
        const capabilities = [
          ...(options.capability ?? []),
          ...deliveryCapabilitiesForMode(deliveryMode)
        ];
        const result = runtime.services.sessions.join({
          name,
          runtime: options.runtime,
          role: options.role,
          deliveryMode,
          cwd: runtime.cwd,
          announcePresence: options.presence !== false,
          capabilities,
          takeover: options.takeover,
          force: options.force
        });
        const claimed =
          deliveryMode === "off"
            ? []
            : runtime.services.delivery.claimForSession({ sessionId: result.sessionId });
        const endpoint = endpointByName(runtime.projections().agents, name);
        const endpointState = result.endpointCreated
          ? "created"
          : result.endpointUpdated
            ? "updated"
            : "existing";

        env.io.write(`agent: ${name} (${endpointState})`);
        env.io.write(`agent_id: ${result.agentId}`);
        env.io.write(`session: ${result.sessionId}`);
        env.io.write(`runtime: ${endpoint?.runtime ?? options.runtime ?? "unknown"}`);
        env.io.write(`role: ${endpoint?.role ?? options.role ?? "none"}`);
        env.io.write(`claimed: ${claimed.length}`);

        if (result.endedSessionIds.length > 0) {
          env.io.write(`ended sessions: ${result.endedSessionIds.join(", ")}`);
        }

        for (const line of runtime.projections().brief.lines) {
          env.io.write(line);
        }
      });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
