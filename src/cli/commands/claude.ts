import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { type Command, Option } from "commander";

import {
  deliveryCapabilitiesForMode,
  recordPendingHostSessionBinding,
  runMonitorWatch
} from "../../adapters/index.js";
import { tachikomaCliInvocation } from "../../config/source-checkout.js";
import type { AgentRole, DeliveryMode, Session } from "../../domain/types.js";
import { endpointByName, liveSessionsForEndpoint } from "../../projections/index.js";
import {
  type DiagnosticItem,
  diagnoseInstall,
  type InstallDiagnostics
} from "../../services/index.js";
import { writeLaunchBanner } from "../launch-banner.js";
import {
  type CliExecutionEnvironment,
  type CliRuntime,
  runtimeOptionsFromCommand,
  withCliRuntime
} from "../runtime.js";
import { nextRuntimeAgentName } from "../runtime-agent-name.js";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

const CLAUDE_EFFORT_LEVELS: readonly ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];

interface ClaudeOptions {
  name?: string;
  role?: AgentRole;
  takeover?: boolean;
  force?: boolean;
  autoBoot?: boolean;
  watch?: boolean;
  dryRun?: boolean;
  effort?: string;
  pollMs?: string;
  maxItems?: string;
  idleTimeoutMs?: string;
}

interface ClaudeStatusOptions {
  name?: string;
}

export function registerClaudeCommand(program: Command, env: CliExecutionEnvironment): void {
  const claude = program
    .command("claude")
    .description("Start or inspect the Claude Tachikoma runtime.")
    .option("--name <name>", "Agent name. Defaults to the next available claude-NN name.")
    .option("--role <role>", "Optional project-local routing label.")
    .option("--effort <level>", "Claude session effort level (low, medium, high, xhigh, max).")
    .option("--takeover", "End existing live sessions for this name before joining.")
    .option("--force", "Update runtime or role metadata for an existing named agent.")
    .option("--no-auto-boot", "Open Claude TUI without submitting the Tachikoma boot prompt.")
    .addOption(
      new Option("--watch", "Run headless monitor delivery without opening Claude TUI.").hideHelp()
    )
    .option("--poll-ms <ms>", "Monitor polling interval.", "1000")
    .option("--max-items <count>", "Maximum monitor directives per poll.", "5")
    .addOption(
      new Option("--dry-run", "Print the Claude TUI launch without running it.").hideHelp()
    )
    .addOption(new Option("--idle-timeout-ms <ms>", "Exit monitor after idle timeout.").hideHelp())
    .action(async function (this: Command) {
      await launchClaudeRuntime(this, env);
    });

  claude
    .command("status")
    .description("Show Claude runtime status checks.")
    .option("--name <name>", "Agent name to inspect.")
    .action(async function (this: Command) {
      const runtimeOptions = runtimeOptionsFromCommand(this, env);
      const diagnostics = diagnoseInstall({
        repoRoot: runtimeOptions.cwd,
        dataRoot: runtimeOptions.dataRoot,
        storePath: runtimeOptions.storePath,
        projectId: runtimeOptions.projectId,
        projectName: runtimeOptions.projectName
      });

      await withCliRuntime(this, env, (runtime) => {
        writeClaudeStatus(
          runtime,
          env,
          diagnostics,
          mergedClaudeOptions<ClaudeStatusOptions>(this)
        );
      });
    });
}

function mergedClaudeOptions<T extends object>(command: Command): T {
  return {
    ...(command.parent?.opts() ?? {}),
    ...command.opts()
  } as T;
}

/**
 * Run the Claude TUI launch flow for a command, merging in any caller-provided
 * option overrides. Shared by `tachikoma claude` and `tachikoma oil claude`.
 */
export async function launchClaudeRuntime(
  command: Command,
  env: CliExecutionEnvironment,
  overrides: Partial<ClaudeOptions> = {}
): Promise<void> {
  const runtimeOptions = runtimeOptionsFromCommand(command, env);
  const diagnostics = diagnoseInstall({
    repoRoot: runtimeOptions.cwd,
    dataRoot: runtimeOptions.dataRoot,
    storePath: runtimeOptions.storePath,
    projectId: runtimeOptions.projectId,
    projectName: runtimeOptions.projectName
  });

  await withCliRuntime(command, env, async (runtime) => {
    await startClaudeRuntime(runtime, env, diagnostics, {
      ...command.opts<ClaudeOptions>(),
      ...overrides
    });
  });
}

async function startClaudeRuntime(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  diagnostics: InstallDiagnostics,
  options: ClaudeOptions
): Promise<void> {
  const agentName = options.name ?? nextRuntimeAgentName(runtime.projections().agents, "claude");
  const effort = parseClaudeEffort(options.effort);
  const headlessWatch = options.watch === true;
  const deliveryMode: DeliveryMode = headlessWatch ? "monitor" : "both";
  const join = runtime.services.sessions.join({
    name: agentName,
    runtime: "claude",
    role: options.role,
    deliveryMode,
    cwd: runtime.cwd,
    announcePresence: true,
    capabilities: [
      ...deliveryCapabilitiesForMode(deliveryMode),
      headlessWatch ? "claude:monitor" : "claude:tui"
    ],
    takeover: options.takeover,
    force: options.force
  });
  const claimed = runtime.services.delivery.claimForSession({ sessionId: join.sessionId });
  const endpoint = endpointByName(runtime.projections().agents, agentName);

  writeLaunchBanner(env.io, "claude", runtime.cwd);
  env.io.write(`agent: ${agentName}`);
  env.io.write(`session: ${join.sessionId}`);
  env.io.write(`runtime: ${endpoint?.runtime ?? "claude"}`);
  env.io.write(`role: ${endpoint?.role ?? options.role ?? "none"}`);
  env.io.write(`delivery_mode: ${deliveryMode}`);
  env.io.write(`claimed: ${claimed.length}`);

  if (join.endedSessionIds.length > 0) {
    env.io.write(`ended sessions: ${join.endedSessionIds.join(", ")}`);
  }

  writeClaudeReadiness(env, diagnostics);
  env.io.write(`tui command: ${claudeTuiCommand(agentName, undefined, effort)}`);
  env.io.write(`monitor command: ${claudeMonitorCommand(runtime.cwd, agentName)}`);
  env.io.write(`fallback receive: ${claudeFallbackReceiveCommand(runtime.cwd, agentName)}`);

  if (!headlessWatch) {
    await runClaudeTui(runtime, env, {
      agentName,
      sessionId: join.sessionId,
      role: endpoint?.role ?? options.role,
      deliveryMode,
      cwd: runtime.cwd,
      autoBoot: options.autoBoot !== false,
      dryRun: options.dryRun === true,
      effort
    });
    return;
  }

  const controller = new AbortController();
  const removeSignalHandlers = installAbortSignalHandlers(controller);

  try {
    env.io.write("watch: waiting for Tachikoma messages. Press Ctrl-C to stop.");
    await runMonitorWatch(runtime.context, runtime.services, {
      sessionId: join.sessionId,
      agentName,
      pollMs: parseOptionalPositiveInteger(options.pollMs, "--poll-ms"),
      maxItems: parseOptionalPositiveInteger(options.maxItems, "--max-items"),
      idleTimeoutMs: parseOptionalNonNegativeInteger(options.idleTimeoutMs, "--idle-timeout-ms"),
      signal: controller.signal,
      onOutput: (output) => {
        env.io.write(output);
      }
    });
  } finally {
    removeSignalHandlers();
    runtime.services.sessions.end({ sessionId: join.sessionId });
  }
}

function writeClaudeStatus(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  diagnostics: InstallDiagnostics,
  options: ClaudeStatusOptions
): void {
  env.io.write(`cwd: ${diagnostics.repoRoot}`);
  writeDiagnostic(env, "claude hooks", diagnostics.claudeHostHooks);
  writeDiagnostic(env, "mcp config", diagnostics.mcpConfig);
  writeDiagnostic(env, "claude monitor readiness", diagnostics.claudeMonitor);
  env.io.write(
    "hook trust: unknown (Claude Code approval is host-local; approve .claude/settings.local.json if hooks stay silent)"
  );

  const endpoints = runtime
    .projections()
    .agents.endpoints.filter(
      (endpoint) =>
        endpoint.runtime === "claude" &&
        (options.name === undefined || endpoint.name === options.name)
    );

  if (endpoints.length === 0) {
    env.io.write(options.name ? `agent: ${options.name} not found` : "claude agents: none");
    env.io.write(
      `next: ${options.name ? `tachikoma claude --name ${options.name}` : "tachikoma claude"}`
    );
    return;
  }

  for (const endpoint of endpoints) {
    const liveSessions = liveSessionsForEndpoint(runtime.projections().agents, endpoint);
    const latestSession = liveSessions.at(-1);
    const activeSession = Boolean(latestSession);

    env.io.write(`${endpoint.name}: ${activeSession ? "live" : "inactive"}`);
    env.io.write(`  role: ${endpoint.role ?? "none"}`);
    env.io.write(`  latest session: ${formatSession(latestSession)}`);
    env.io.write(`  pending messages: ${pendingInboxCount(runtime, endpoint.name)}`);
    env.io.write(`  tui command: tachikoma claude --name ${endpoint.name}`);
    env.io.write(`  monitor command: ${claudeMonitorCommand(runtime.cwd, endpoint.name)}`);

    if (!activeSession) {
      env.io.write(`  next: start TUI with \`tachikoma claude --name ${endpoint.name}\``);
    }
  }
}

function writeClaudeReadiness(env: CliExecutionEnvironment, diagnostics: InstallDiagnostics): void {
  writeDiagnostic(env, "claude hooks", diagnostics.claudeHostHooks);
  writeDiagnostic(env, "mcp config", diagnostics.mcpConfig);
  writeDiagnostic(env, "claude monitor readiness", diagnostics.claudeMonitor);
}

function writeDiagnostic(env: CliExecutionEnvironment, label: string, item: DiagnosticItem): void {
  env.io.write(`${label}: ${item.status} ${item.message}`);
}

function formatSession(session: Session | undefined): string {
  if (!session) {
    return "none";
  }

  return `${session.id} delivery=${session.deliveryMode}`;
}

function pendingInboxCount(runtime: CliRuntime, agentName: string): number {
  return runtime
    .projections()
    .inbox.items.filter(
      (item) =>
        item.target.kind === "agent" &&
        item.target.name === agentName &&
        item.status !== "read" &&
        item.status !== "cancelled"
    ).length;
}

interface ClaudeTuiLaunchOptions {
  agentName: string;
  sessionId: string;
  role?: AgentRole;
  deliveryMode: DeliveryMode;
  cwd: string;
  autoBoot: boolean;
  dryRun: boolean;
  effort?: ClaudeEffort;
}

async function runClaudeTui(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  options: ClaudeTuiLaunchOptions
): Promise<void> {
  const launchEnv = claudeTuiEnvironment(options);
  const bootPrompt = options.autoBoot
    ? claudeBootPrompt(runtime.cwd, {
        agentName: options.agentName,
        sessionId: options.sessionId,
        deliveryMode: options.deliveryMode
      })
    : undefined;

  env.io.write("tui: opening Claude TUI. Exit Claude to stop this Tachikoma session.");
  env.io.write(`boot prompt: ${bootPrompt ? "enabled" : "disabled"}`);

  if (bootPrompt && !options.dryRun) {
    recordPendingHostSessionBinding(runtime.context, {
      runtime: "claude",
      agentName: options.agentName,
      tachikomaSessionId: options.sessionId,
      source: "tachikoma claude"
    });
  }

  if (options.dryRun) {
    env.io.write(`claude tui: ${claudeTuiCommand(options.agentName, bootPrompt, options.effort)}`);
    env.io.write(`env: TACHIKOMA_AGENT_NAME=${launchEnv.TACHIKOMA_AGENT_NAME}`);
    env.io.write(`env: TACHIKOMA_SESSION_ID=${launchEnv.TACHIKOMA_SESSION_ID}`);
    env.io.write(`env: TACHIKOMA_RUNTIME=${launchEnv.TACHIKOMA_RUNTIME}`);
    env.io.write(`env: TACHIKOMA_MONITOR_COMMAND=${launchEnv.TACHIKOMA_MONITOR_COMMAND}`);
    env.io.write("dry-run: Claude TUI not started");
    return;
  }

  try {
    await spawnClaudeTui(runtime.cwd, options.agentName, launchEnv, bootPrompt, options.effort);
  } finally {
    runtime.services.sessions.end({ sessionId: options.sessionId });
  }
}

function claudeTuiEnvironment(options: ClaudeTuiLaunchOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TACHIKOMA_AGENT_NAME: options.agentName,
    TACHIKOMA_SESSION_ID: options.sessionId,
    TACHIKOMA_RUNTIME: "claude",
    TACHIKOMA_CWD: options.cwd,
    TACHIKOMA_MONITOR_COMMAND: claudeMonitorCommand(options.cwd, options.agentName),
    ...(options.role ? { TACHIKOMA_ROLE: options.role } : {}),
    TACHIKOMA_DELIVERY_MODE: options.deliveryMode
  };
}

function spawnClaudeTui(
  cwd: string,
  agentName: string,
  env: NodeJS.ProcessEnv,
  bootPrompt: string | undefined,
  effort: ClaudeEffort | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveClaudeCommand(), claudeTuiArgs(agentName, bootPrompt, effort), {
      cwd,
      env,
      stdio: "inherit"
    });

    child.once("error", (error) => {
      reject(new Error(`Failed to start Claude TUI: ${error.message}`));
    });

    child.once("exit", (code, signal) => {
      if (code === 0 || (code === null && signal)) {
        resolve();
        return;
      }

      reject(new Error(`Claude TUI exited with code ${code ?? `signal ${signal}`}.`));
    });
  });
}

/**
 * Resolve the `claude` executable to spawn. `spawn` searches PATH but cannot
 * see shell aliases, so an install where `claude` is only a `.zshrc` alias
 * (e.g. the Claude Code local install at `~/.claude/local/claude`) fails with
 * `spawn claude ENOENT`. Honor an explicit override, then fall back to the
 * known local-install path before deferring to PATH resolution.
 */
function resolveClaudeCommand(): string {
  const override = process.env.TACHIKOMA_CLAUDE_COMMAND?.trim();
  if (override) {
    return override;
  }

  if (!findExecutableOnPath("claude")) {
    const localInstall = join(homedir(), ".claude", "local", "claude");
    if (isExecutableFile(localInstall)) {
      return localInstall;
    }
  }

  return "claude";
}

function findExecutableOnPath(command: string): string | undefined {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return undefined;
  }

  for (const dir of pathValue.split(delimiter)) {
    if (!dir) {
      continue;
    }

    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function claudeTuiArgs(
  agentName: string,
  bootPrompt: string | undefined,
  effort?: ClaudeEffort
): string[] {
  const args = ["--name", agentName];

  if (effort) {
    // `--effort` alone loses to a `CLAUDE_CODE_EFFORT_LEVEL` exported from the
    // user's settings `env` block, which claude re-applies over the process env.
    // `--settings` (flagSettings) outranks userSettings, so pinning the effort
    // env there is what actually controls the launched session.
    args.push("--effort", effort);
    args.push("--settings", claudeEffortSettings(effort));
  }

  if (bootPrompt) {
    args.push(bootPrompt);
  }

  return args;
}

function claudeEffortSettings(effort: ClaudeEffort): string {
  return JSON.stringify({
    env: { CLAUDE_CODE_EFFORT_LEVEL: effort, CLAUDE_EFFORT: effort }
  });
}

function claudeTuiCommand(agentName: string, bootPrompt?: string, effort?: ClaudeEffort): string {
  return formatShellCommand(resolveClaudeCommand(), claudeTuiArgs(agentName, bootPrompt, effort));
}

function claudeMonitorCommand(cwd: string, agentName: string): string {
  const cli = tachikomaCliInvocation(cwd);
  return formatShellCommand(cli.command, [
    ...cli.leadingArgs,
    "--cwd",
    cwd,
    "hook",
    "monitor",
    "--name",
    agentName,
    "--watch",
    "--poll-ms",
    "1000",
    "--max-items",
    "5"
  ]);
}

function claudeFallbackReceiveCommand(cwd: string, agentName: string): string {
  const cli = tachikomaCliInvocation(cwd);
  return formatShellCommand(cli.command, [
    ...cli.leadingArgs,
    "--cwd",
    cwd,
    "hook",
    "receive",
    "--runtime",
    "claude",
    "--name",
    agentName,
    "--format",
    "text",
    "--event",
    "UserPromptSubmit"
  ]);
}

function claudeBootPrompt(
  _cwd: string,
  _input: {
    agentName: string;
    sessionId: string;
    deliveryMode: DeliveryMode;
  }
): string {
  return "/tachikoma-boot";
}

function formatShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function installAbortSignalHandlers(controller: AbortController): () => void {
  const abort = () => {
    controller.abort();
  };

  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  return () => {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  };
}

export function parseClaudeEffort(value: string | undefined): ClaudeEffort | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  const match = CLAUDE_EFFORT_LEVELS.find((level) => level === normalized);
  if (!match) {
    throw new Error(`--effort must be one of: ${CLAUDE_EFFORT_LEVELS.join(", ")}.`);
  }

  return match;
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  label: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed.toString() !== value) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function parseOptionalNonNegativeInteger(
  value: string | undefined,
  label: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed.toString() !== value) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return parsed;
}
