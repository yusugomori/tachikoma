import { resolve } from "node:path";

import { type Command, Option } from "commander";

import {
  CodexAppServerClient,
  runCodexAppServerProbe,
  StdioCodexAppServerTransport,
  writeCodexRemoteControlBinding
} from "../../adapters/index.js";
import { type CliExecutionEnvironment, runtimeOptionsFromCommand } from "../runtime.js";

export interface CodexRemoteProbeOptions {
  cwd?: string;
  message: string;
  agent?: string;
  thread?: string;
  newThread?: boolean;
  appServerStdio?: boolean;
  socket?: string;
  timeoutMs?: string;
  waitMs?: string;
  proxyCommand?: string;
  proxyArg?: string[];
}

export function registerCodexRemoteCommand(program: Command, env: CliExecutionEnvironment): void {
  const codexRemote = program
    .command("codex-remote")
    .description("[experimental] Probe Codex app-server remote-control delivery.");

  addCodexRemoteProbeCommand(codexRemote.command("probe"), env);
}

export function addCodexRemoteProbeCommand(
  command: Command,
  env: CliExecutionEnvironment
): Command {
  return command
    .description("Probe whether Codex app-server accepts a Tachikoma delivery turn.")
    .requiredOption("--message <message>", "Tachikoma delivery prompt to send to Codex.")
    .option("--cwd <repo>", "Repository cwd to match against Codex threads.")
    .option("--agent <agent_name>", "Tachikoma agent name to bind on accepted turns.")
    .option("--thread <thread_id>", "Existing Codex thread id to target.")
    .option("--new-thread", "Start a new Codex app-server-managed thread.")
    .option("--app-server-stdio", "Run codex app-server directly over stdio.")
    .option("--socket <path>", "Codex app-server Unix socket path for codex app-server proxy.")
    .option("--timeout-ms <ms>", "JSON-RPC request timeout.", "15000")
    .option("--wait-ms <ms>", "Wait for turn completion before closing the probe.", "60000")
    .addOption(new Option("--proxy-command <command>", "Proxy command override.").hideHelp())
    .addOption(
      new Option("--proxy-arg <arg>", "Proxy command argument override.")
        .argParser(collect)
        .default([])
        .hideHelp()
    )
    .action(async function (this: Command, options: CodexRemoteProbeOptions) {
      const runtimeOptions = runtimeOptionsFromCommand(this, env);
      const cwd = resolve(options.cwd ?? runtimeOptions.cwd ?? env.cwd ?? process.cwd());
      const proxy = proxyCommand(options);
      const timeoutMs = parsePositiveIntegerOption(options.timeoutMs, "--timeout-ms");
      const waitMs = parseNonNegativeIntegerOption(options.waitMs, "--wait-ms");
      const transport = new StdioCodexAppServerTransport({
        command: proxy.command,
        args: proxy.args,
        requestTimeoutMs: timeoutMs
      });
      const client = new CodexAppServerClient(transport);

      try {
        const result = await runCodexAppServerProbe(
          {
            cwd,
            message: options.message,
            threadId: options.thread,
            forceNewThread: options.newThread,
            waitForCompletionMs: waitMs
          },
          client
        );

        if (result.status === "accepted" && options.agent && result.threadId) {
          writeCodexRemoteControlBinding(cwd, {
            agentName: options.agent,
            codexThreadId: result.threadId,
            cwd,
            threadOrigin: result.threadOrigin ?? "existing",
            lastTurnId: result.turnId
          });
        }

        writeProbeResult(env, result, options.agent);
      } catch (error) {
        env.io.write("codex remote probe: unavailable");
        env.io.write(`cwd: ${cwd}`);
        env.io.write(`reason: ${error instanceof Error ? error.message : String(error)}`);
        env.io.write("delivery: Tachikoma messages were not marked delivered by this probe.");
      } finally {
        await transport.close();
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function proxyCommand(options: CodexRemoteProbeOptions): { command: string; args: string[] } {
  if (options.proxyCommand) {
    return {
      command: options.proxyCommand,
      args: options.proxyArg ?? []
    };
  }

  if (options.appServerStdio) {
    return {
      command: "codex",
      args: ["app-server"]
    };
  }

  return {
    command: "codex",
    args: ["app-server", "proxy", ...(options.socket ? ["--sock", options.socket] : [])]
  };
}

function parsePositiveIntegerOption(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed.toString() !== value) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeIntegerOption(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed.toString() !== value) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return parsed;
}

function writeProbeResult(
  env: CliExecutionEnvironment,
  result: Awaited<ReturnType<typeof runCodexAppServerProbe>>,
  agentName: string | undefined
): void {
  env.io.write(`codex remote probe: ${result.status}`);
  env.io.write(`cwd: ${result.cwd}`);
  env.io.write(`threads: ${result.threadsSeen}`);

  if (result.threadId) {
    env.io.write(`thread: ${result.threadId} (${result.threadOrigin ?? "existing"})`);
  }

  if (result.turnId) {
    env.io.write(`turn: ${result.turnId}${result.turnStatus ? ` (${result.turnStatus})` : ""}`);
  }

  if (result.completionStatus) {
    env.io.write(`completion: ${result.completionStatus}`);
  }

  if (result.fallbackReason) {
    env.io.write(`fallback: existing thread rejected; started managed thread`);
    env.io.write(`fallback reason: ${result.fallbackReason}`);
  }

  if (agentName && result.status === "accepted") {
    env.io.write(`binding: recorded for ${agentName}`);
  }

  if (result.reason) {
    env.io.write(`reason: ${result.reason}`);
  }

  if (result.completionWarning) {
    env.io.write(`completion warning: ${result.completionWarning}`);
  }

  if (result.readWarning) {
    env.io.write(`read warning: ${result.readWarning}`);
  }

  env.io.write("delivery: Tachikoma messages were not marked delivered by this probe.");
}
