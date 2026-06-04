import type { Command } from "commander";

import type { AgentRole, AgentRuntime } from "../../domain/types.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface RegisterOptions {
  runtime: AgentRuntime;
  role?: AgentRole;
}

export function registerAgentCommand(program: Command, env: CliExecutionEnvironment): void {
  const agent = program.command("agent").description("Manage named agent endpoints.");

  agent
    .command("register <name>")
    .description("Register or update a named agent endpoint.")
    .requiredOption("--runtime <runtime>", "Agent runtime: codex, claude, or other.")
    .option("--role <role>", "Optional project-local routing label.")
    .action(async function (this: Command, name: string, options: RegisterOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const event = runtime.services.agents.registerEndpoint({
          name,
          runtime: options.runtime,
          role: options.role
        });

        env.io.write(`registered agent: ${name}`);
        env.io.write(`agent: ${event.target.agentId}`);
      });
    });
}
