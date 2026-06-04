import type { Command } from "commander";

import type { AgentRole, AgentRuntime, DeliveryMode } from "../../domain/types.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface StartSessionOptions {
  name?: string;
  agent?: string;
  runtime?: AgentRuntime;
  role?: AgentRole;
  deliveryMode?: DeliveryMode;
  presence?: boolean;
  capability?: string[];
}

interface EndSessionOptions {
  session: string;
}

export function registerSessionCommand(program: Command, env: CliExecutionEnvironment): void {
  const session = program.command("session").description("Manage active agent sessions.");

  session
    .command("start")
    .description("Start a session and claim queued work for that session.")
    .option("--name <name>", "Registered agent endpoint name.")
    .option("--agent <agent_id>", "Registered agent endpoint id.")
    .option("--runtime <runtime>", "Runtime override.")
    .option("--role <role>", "Role override.")
    .option("--delivery-mode <mode>", "Delivery mode.", "turn")
    .option("--no-presence", "Start without announcing presence.")
    .option("--capability <capability>", "Presence capability.", collect, [])
    .action(async function (this: Command, options: StartSessionOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const events = runtime.services.sessions.start({
          name: options.name,
          agentId: options.agent,
          runtime: options.runtime,
          role: options.role,
          deliveryMode: options.deliveryMode ?? "turn",
          cwd: runtime.cwd,
          announcePresence: options.presence !== false,
          capabilities: options.capability ?? []
        });
        const sessionId = events.find((event) => event.type === "session.started")?.target
          .sessionId;

        if (!sessionId) {
          throw new Error("session.start did not return a session id.");
        }

        const claimed = runtime.services.delivery.claimForSession({ sessionId });

        env.io.write(`session: ${sessionId}`);
        env.io.write(`claimed: ${claimed.length}`);
      });
    });

  session
    .command("end")
    .description("End an active session.")
    .requiredOption("--session <session_id>", "Session id.")
    .action(async function (this: Command, options: EndSessionOptions) {
      await withCliRuntime(this, env, (runtime) => {
        runtime.services.sessions.end({ sessionId: options.session });
        env.io.write(`ended session: ${options.session}`);
      });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
