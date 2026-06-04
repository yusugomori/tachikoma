import type { Command } from "commander";

import { startStdioServer } from "../../mcp/index.js";
import { type CliExecutionEnvironment, runtimeOptionsFromCommand } from "../runtime.js";

export function registerMcpCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("mcp")
    .description("Start Tachikoma MCP server over stdio.")
    .action(async function (this: Command) {
      const options = runtimeOptionsFromCommand(this, env);

      await startStdioServer({
        cwd: options.cwd,
        storePath: options.storePath,
        projectId: options.projectId,
        projectName: options.projectName,
        dataRoot: options.dataRoot,
        actor: options.actor
      });
    });
}
