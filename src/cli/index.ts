#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";

import { registerAckCommand } from "./commands/ack.js";
import { registerAgentCommand } from "./commands/agent.js";
import { registerAskCommand } from "./commands/ask.js";
import { registerClaimCommand } from "./commands/claim.js";
import { registerClaudeCommand } from "./commands/claude.js";
import { registerCodexCommand } from "./commands/codex.js";
import { registerCodexRemoteCommand } from "./commands/codex-remote.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerHookCommand } from "./commands/hook.js";
import { registerInboxCommand } from "./commands/inbox.js";
import { registerInitCommand } from "./commands/init.js";
import { registerInstallCommand } from "./commands/install.js";
import { registerJoinCommand } from "./commands/join.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { registerMessageCommand } from "./commands/message.js";
import { registerOilCommand } from "./commands/oil.js";
import { registerReplyCommand } from "./commands/reply.js";
import { registerReportCommand } from "./commands/report.js";
import { registerResetCommand } from "./commands/reset.js";
import { registerReviewCommand } from "./commands/review.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerThreadCommand } from "./commands/thread.js";
import { registerUninstallCommand } from "./commands/uninstall.js";
import { registerVerificationCommand } from "./commands/verification.js";
import { type CliIo, createConsoleIo, formatError } from "./io.js";

export interface MainOptions {
  cwd?: string;
  io?: CliIo;
  stdin?: string;
}

export async function main(argv = process.argv.slice(2), options: MainOptions = {}): Promise<void> {
  const io = options.io ?? createConsoleIo();
  const program = buildProgram({
    cwd: options.cwd,
    io,
    stdin: options.stdin
  });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    ) {
      return;
    }

    io.error(formatError(error));
    throw error;
  }
}

function buildProgram(
  options: Required<Pick<MainOptions, "io">> & Pick<MainOptions, "cwd" | "stdin">
) {
  const program = new Command();
  const env = {
    cwd: options.cwd,
    io: options.io,
    stdin: options.stdin
  };

  program
    .name("tachikoma")
    .description("Local project-state runtime for coding agents.")
    .version("0.1.0")
    .option("--cwd <path>", "Target repository cwd.")
    .option("--project <project_id>", "Project id.")
    .option("--project-name <name>", "Project display name.")
    .option("--store <path>", "SQLite store path.")
    .option("--data-root <path>", "Tachikoma local data root.")
    .option("--as <agent_name>", "Actor agent name.")
    .option("--actor-runtime <runtime>", "Actor runtime.")
    .option("--actor-role <role>", "Actor role.")
    .option("--actor-session <session_id>", "Actor session id.")
    .action(() => {
      options.io.write("No command specified.");
      program.outputHelp();
    })
    .configureOutput({
      writeOut: (message) => {
        options.io.write(message.trimEnd());
      },
      writeErr: (message) => {
        options.io.error(message.trimEnd());
      }
    })
    .exitOverride();

  registerInitCommand(program, env);
  registerInstallCommand(program, env);
  registerResetCommand(program, env);
  registerUninstallCommand(program, env);
  registerJoinCommand(program, env);
  registerAgentCommand(program, env);
  registerSessionCommand(program, env);
  registerClaudeCommand(program, env);
  registerCodexCommand(program, env);
  registerOilCommand(program, env);
  registerAckCommand(program, env);
  registerAskCommand(program, env);
  registerInboxCommand(program, env);
  registerReplyCommand(program, env);
  registerThreadCommand(program, env);
  registerStatusCommand(program, env);
  registerTaskCommand(program, env);
  registerMessageCommand(program, env);
  registerClaimCommand(program, env);
  registerReviewCommand(program, env);
  registerVerificationCommand(program, env);
  registerMemoryCommand(program, env);
  registerReportCommand(program, env);
  registerDoctorCommand(program, env);
  registerHookCommand(program, env);
  registerCodexRemoteCommand(program, env);
  registerMcpCommand(program, env);

  return program;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  const here = fileURLToPath(import.meta.url);
  if (entry === here) {
    return true;
  }

  // When tachikoma is installed globally (`npm i -g`), the `tachikoma` bin is a
  // symlink into node_modules. `process.argv[1]` keeps the symlink path while
  // `import.meta.url` is already realpath-resolved, so a raw equality check
  // fails and `main()` never runs — the CLI exits silently. Compare realpaths.
  try {
    return realpathSync(entry) === here;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
