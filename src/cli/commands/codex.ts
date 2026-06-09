import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { type Command, Option } from "commander";

import {
  CodexAppServerClient,
  type CodexAppServerLifecycle,
  type CodexAppServerWorker,
  type CodexManagedThread,
  deliveryCapabilitiesForMode,
  findFreePort,
  isProcessAlive,
  readCodexAppServerWorkers,
  recordPendingHostSessionBinding,
  removeCodexAppServerWorkers,
  startCodexAppServerProcess,
  stopCodexAppServerPid,
  WebSocketCodexAppServerTransport,
  writeCodexAppServerWorker,
  writeCodexAppServerWorkers
} from "../../adapters/index.js";
import type { AgentRole, DeliveryMode } from "../../domain/types.js";
import { endpointByName } from "../../projections/index.js";
import type { CodexDeliveryResult } from "../../services/index.js";
import { writeLaunchBanner } from "../launch-banner.js";
import { type CliExecutionEnvironment, type CliRuntime, withCliRuntime } from "../runtime.js";
import { nextRuntimeAgentName } from "../runtime-agent-name.js";
import { addCodexRemoteProbeCommand } from "./codex-remote.js";

interface CodexStartOptions {
  name?: string;
  role?: AgentRole;
  watch?: boolean;
  keepServer?: boolean;
  port?: string;
  takeover?: boolean;
  force?: boolean;
  pollMs?: string;
  readyTimeoutMs?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  dryRun?: boolean;
}

interface CodexAttachOptions {
  name?: string;
  dryRun?: boolean;
}

interface CodexStatusOptions {
  name?: string;
}

interface CodexStopOptions {
  name?: string;
  all?: boolean;
}

interface CodexDeliverOptions {
  name?: string;
  once?: boolean;
  watch?: boolean;
  pollMs?: string;
  maxItems?: string;
  requestTimeoutMs?: string;
}

interface CodexWorkerStartResult {
  worker: CodexAppServerWorker;
  managedThread?: CodexManagedThread;
  reused: boolean;
}

interface CodexRuntimeBehavior {
  runDeliveryLoop: boolean;
  attachCodexTui: boolean;
  workerLifecycle: CodexAppServerLifecycle;
  cleanupOnExit: boolean;
}

export function registerCodexCommand(program: Command, env: CliExecutionEnvironment): void {
  const codex = program
    .command("codex")
    .description("Start or inspect the Codex Tachikoma runtime.");

  addStartOptions(codex, { includeAttach: true });

  addStartOptions(
    codex.command("start").description("Start or reuse a Codex app-server worker.")
  ).action(async function (this: Command) {
    await startCodexRuntime(this, env, mergedOptions<CodexStartOptions>(this), {
      runDeliveryLoop: false,
      attachCodexTui: false,
      workerLifecycle: "daemon",
      cleanupOnExit: false
    });
  });

  codex
    .command("status")
    .description("Show Codex app-server worker status.")
    .option("--name <name>", "Agent name to inspect.")
    .action(async function (this: Command) {
      await withCliRuntime(this, env, (runtime) => {
        writeCodexStatus(runtime, env, mergedOptions<CodexStatusOptions>(this));
      });
    });

  codex
    .command("attach")
    .description("Open a Codex TUI for a running Tachikoma Codex worker.")
    .option("--name <name>", "Agent name to attach.")
    .addOption(new Option("--dry-run", "Print the attach command without running it.").hideHelp())
    .action(async function (this: Command) {
      await withCliRuntime(this, env, async (runtime) => {
        await attachCodexWorker(runtime, env, mergedOptions<CodexAttachOptions>(this));
      });
    });

  codex
    .command("deliver")
    .description("Deliver pending Tachikoma messages to a Codex app-server worker.")
    .option("--name <name>", "Agent name to deliver for.")
    .option("--once", "Deliver one batch and exit.")
    .option("--watch", "Poll for pending messages until interrupted.")
    .option("--poll-ms <ms>", "Delivery loop poll interval.", "1000")
    .option("--max-items <count>", "Maximum messages to deliver per batch.", "5")
    .option("--request-timeout-ms <ms>", "Codex app-server JSON-RPC request timeout.", "15000")
    .action(async function (this: Command) {
      await withCliRuntime(this, env, async (runtime) => {
        await runCodexDeliveryCommand(runtime, env, mergedOptions<CodexDeliverOptions>(this));
      });
    });

  codex
    .command("stop")
    .description("Stop Tachikoma-started Codex app-server workers.")
    .option("--name <name>", "Agent name to stop.")
    .option("--all", "Stop all Tachikoma-started Codex app-server workers for this repository.")
    .action(async function (this: Command) {
      await withCliRuntime(this, env, async (runtime) => {
        await stopCodexWorkers(runtime, env, mergedOptions<CodexStopOptions>(this));
      });
    });

  addCodexRemoteProbeCommand(
    codex.command("probe").description("Probe Codex app-server delivery."),
    env
  );

  codex.action(async function (this: Command) {
    await launchCodexRuntime(this, env, this.opts<CodexStartOptions>());
  });
}

/**
 * Run the default Codex launch flow (open TUI + delivery loop) for a command,
 * merging in caller-provided option overrides. Shared by `tachikoma codex` and
 * `tachikoma oil codex`.
 */
export async function launchCodexRuntime(
  command: Command,
  env: CliExecutionEnvironment,
  overrides: Partial<CodexStartOptions> = {}
): Promise<void> {
  const options = { ...mergedOptions<CodexStartOptions>(command), ...overrides };
  const keepServer = options.keepServer === true;
  const headlessWatch = options.watch === true;

  await startCodexRuntime(command, env, options, {
    runDeliveryLoop: true,
    attachCodexTui: !headlessWatch,
    workerLifecycle: keepServer || headlessWatch ? "daemon" : "foreground",
    cleanupOnExit: !keepServer
  });
}

function mergedOptions<T extends object>(command: Command): T {
  return {
    ...(command.parent?.opts() ?? {}),
    ...command.opts()
  } as T;
}

/**
 * Build `codex` global `-c key=value` config override args from the oil/effort
 * options. Bare values (e.g. `xhigh`) fail TOML parsing and fall back to a
 * literal string, matching Codex's own `-c key=all` convention.
 */
function codexConfigArgs(options: CodexStartOptions): string[] {
  const args: string[] = [];

  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${options.reasoningEffort}`);
  }

  if (options.serviceTier) {
    args.push("-c", `service_tier=${options.serviceTier}`);
  }

  return args;
}

function codexCommandName(): string {
  return process.env.TACHIKOMA_CODEX_COMMAND ?? "codex";
}

function addStartOptions(command: Command, options: { includeAttach?: boolean } = {}): Command {
  if (options.includeAttach) {
    command.option("--watch", "Run headless delivery watch without opening Codex TUI.");
  }

  return command
    .option("--name <name>", "Agent name. Defaults to the next available codex-NN name.")
    .option("--role <role>", "Optional project-local routing label.")
    .option("--reasoning-effort <level>", "Codex model_reasoning_effort override (e.g. xhigh).")
    .option("--service-tier <tier>", "Codex service_tier override (e.g. fast, default).")
    .option("--keep-server", "Keep Tachikoma-started Codex app-server running after exit.")
    .option("--port <port>", "Fixed localhost app-server port.")
    .option("--takeover", "End existing live sessions for this name before joining.")
    .option("--force", "Update runtime or role metadata for an existing named agent.")
    .option("--poll-ms <ms>", "Delivery loop poll interval.")
    .addOption(new Option("--ready-timeout-ms <ms>", "App-server readiness timeout.").hideHelp())
    .addOption(
      new Option("--dry-run", "Print the Codex launch plan without starting it.").hideHelp()
    );
}

async function startCodexRuntime(
  command: Command,
  env: CliExecutionEnvironment,
  options: CodexStartOptions,
  behavior: CodexRuntimeBehavior
): Promise<void> {
  await withCliRuntime(command, env, async (runtime) => {
    const removedStaleWorkers = removeStaleCodexWorkers(runtime);
    for (const worker of removedStaleWorkers) {
      env.io.write(`removed stale app-server state: ${worker.agentName}`);
    }

    const agentName = options.name ?? nextRuntimeAgentName(runtime.projections().agents, "codex");
    const join = runtime.services.sessions.join({
      name: agentName,
      runtime: "codex",
      role: options.role,
      deliveryMode: "realtime",
      cwd: runtime.cwd,
      announcePresence: true,
      capabilities: [...deliveryCapabilitiesForMode("realtime"), "codex:app-server"],
      takeover: options.takeover,
      force: options.force
    });
    const endpoint = endpointByName(runtime.projections().agents, agentName);
    writeLaunchBanner(env.io, "codex", runtime.cwd);

    let cleanupWorker: CodexAppServerWorker | undefined;
    let joinedSessionEnded = false;
    const endJoinedSession = () => {
      if (joinedSessionEnded) {
        return;
      }

      runtime.services.sessions.end({ sessionId: join.sessionId });
      joinedSessionEnded = true;
    };

    const configArgs = codexConfigArgs(options);

    if (options.dryRun) {
      await writeCodexDryRun(env, {
        agentName,
        endedSessionIds: join.endedSessionIds,
        sessionId: join.sessionId,
        port: parseOptionalPositiveInteger(options.port, "--port"),
        configArgs,
        attachCodexTui: behavior.attachCodexTui
      });
      endJoinedSession();
      return;
    }

    try {
      const result = await ensureCodexWorker(runtime, {
        agentName,
        role: endpoint?.role ?? options.role,
        sessionId: join.sessionId,
        lifecycle: behavior.workerLifecycle,
        detached: behavior.workerLifecycle !== "foreground",
        port: parseOptionalPositiveInteger(options.port, "--port"),
        readyTimeoutMs: parseOptionalPositiveInteger(options.readyTimeoutMs, "--ready-timeout-ms"),
        initializeThread: !behavior.attachCodexTui,
        configArgs
      });
      cleanupWorker =
        behavior.cleanupOnExit && !result.reused && result.worker.startedByTachikoma
          ? result.worker
          : undefined;

      try {
        const unregisterForegroundCleanup = cleanupWorker
          ? registerForegroundCleanup(runtime, env, cleanupWorker)
          : undefined;

        try {
          await runStartedCodexRuntime(runtime, env, options, behavior, join, result, agentName);
        } finally {
          unregisterForegroundCleanup?.();
        }
      } finally {
        if (cleanupWorker) {
          await cleanupForegroundCodexWorker(runtime, env, cleanupWorker, { endSession: false });
        }
      }
    } catch (error) {
      if (!cleanupWorker) {
        endJoinedSession();
      }
      throw error;
    } finally {
      if (behavior.cleanupOnExit) {
        endJoinedSession();
      }
    }
  });
}

async function runStartedCodexRuntime(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  options: CodexStartOptions,
  behavior: CodexRuntimeBehavior,
  join: { sessionId: string; endedSessionIds: string[] },
  result: CodexWorkerStartResult,
  agentName: string
): Promise<void> {
  env.io.write(`agent: ${agentName}`);
  env.io.write(`session: ${join.sessionId}`);
  env.io.write(`app-server: ${result.worker.serverUrl} (${result.reused ? "reused" : "started"})`);
  env.io.write(`pid: ${result.worker.pid ?? "unknown"}`);
  env.io.write(
    `thread: ${result.worker.codexThreadId ?? (behavior.attachCodexTui ? "waiting-for-tui" : "unknown")} (${result.managedThread?.threadOrigin ?? "foreground"})`
  );

  if (result.managedThread?.fallbackReason) {
    env.io.write(`thread fallback: ${result.managedThread.fallbackReason}`);
  }

  if (join.endedSessionIds.length > 0) {
    env.io.write(`ended sessions: ${join.endedSessionIds.join(", ")}`);
  }

  env.io.write(`attach: tachikoma codex attach --name ${agentName}`);

  if (options.keepServer) {
    env.io.write("keep-server: app-server state is retained until `tachikoma codex stop`.");
  }

  if (!behavior.runDeliveryLoop) {
    env.io.write(
      `delivery: run \`tachikoma codex --name ${agentName}\` to open Codex TUI, or \`tachikoma codex --name ${agentName} --watch\` for headless delivery.`
    );
    return;
  }

  const deliveryOptions = {
    agentName,
    pollMs: parseOptionalPositiveInteger(options.pollMs, "--poll-ms") ?? 1000,
    maxItems: 5,
    requestTimeoutMs: 15000
  };

  if (behavior.attachCodexTui) {
    const controller = new AbortController();
    const loopPromise = runCodexDeliveryLoop(runtime, env, {
      ...deliveryOptions,
      signal: controller.signal,
      reportResults: false
    });

    try {
      env.io.write("delivery loop: active while Codex TUI is attached.");
      recordCodexPendingHostBinding(runtime, {
        agentName,
        sessionId: join.sessionId,
        source: "tachikoma codex"
      });
      await runCodexTuiAttach(env, result.worker.serverUrl, {
        agentName,
        sessionId: join.sessionId,
        role: result.worker.role ?? options.role,
        deliveryMode: "realtime",
        configArgs: codexConfigArgs(options)
      });
    } finally {
      controller.abort();
      await loopPromise;
    }
    return;
  }

  env.io.write("delivery loop: waiting for Tachikoma messages. Press Ctrl-C to stop.");
  await runCodexDeliveryLoop(runtime, env, deliveryOptions);
}

async function writeCodexDryRun(
  env: CliExecutionEnvironment,
  input: {
    agentName: string;
    sessionId: string;
    endedSessionIds: string[];
    port?: number;
    configArgs: string[];
    attachCodexTui: boolean;
  }
): Promise<void> {
  const port = input.port ?? (await findFreePort());
  const serverUrl = `ws://127.0.0.1:${port}`;
  const command = codexCommandName();

  env.io.write(`agent: ${input.agentName}`);
  env.io.write(`session: ${input.sessionId}`);

  if (input.endedSessionIds.length > 0) {
    env.io.write(`ended sessions: ${input.endedSessionIds.join(", ")}`);
  }

  env.io.write(
    `app-server command: ${formatShellCommand(command, [...input.configArgs, "app-server", "--listen", serverUrl])}`
  );

  if (input.attachCodexTui) {
    env.io.write(
      `attach command: ${formatShellCommand(command, [...input.configArgs, "--remote", serverUrl])}`
    );
  }

  env.io.write("dry-run: Codex app-server not started");
}

function registerForegroundCleanup(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  worker: CodexAppServerWorker
): () => void {
  let cleaned = false;
  const cleanup = (reason: "exit" | NodeJS.Signals) => {
    if (cleaned) {
      return;
    }

    cleaned = true;
    cleanupForegroundCodexWorkerSync(runtime, worker);

    if (reason !== "exit") {
      env.io.write(`stopped app-server: ${worker.agentName}`);
    }
  };
  const onExit = () => {
    cleanup("exit");
  };
  const onSignal = (signal: NodeJS.Signals) => {
    cleanup(signal);
    process.exit(signalExitCode(signal));
  };

  process.once("exit", onExit);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);

  return () => {
    process.off("exit", onExit);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
  };
}

function cleanupForegroundCodexWorkerSync(runtime: CliRuntime, worker: CodexAppServerWorker): void {
  if (worker.pid && isProcessAlive(worker.pid)) {
    try {
      process.kill(worker.pid, "SIGTERM");
    } catch {
      // Best-effort cleanup during process exit.
    }
  }

  removeWorkers(runtime.cwd, [worker]);

  if (worker.sessionId) {
    try {
      runtime.services.sessions.end({ sessionId: worker.sessionId });
    } catch {
      // Best-effort cleanup during process exit.
    }
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}

async function runCodexDeliveryCommand(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  options: CodexDeliverOptions
): Promise<void> {
  const agentName = options.name;
  if (!agentName) {
    throw new Error("tachikoma codex deliver requires --name <name>.");
  }

  const deliveryOptions = {
    agentName,
    pollMs: parseOptionalPositiveInteger(options.pollMs, "--poll-ms") ?? 1000,
    maxItems: parseOptionalPositiveInteger(options.maxItems, "--max-items") ?? 5,
    requestTimeoutMs:
      parseOptionalPositiveInteger(options.requestTimeoutMs, "--request-timeout-ms") ?? 15000
  };

  if (options.watch && !options.once) {
    await runCodexDeliveryLoop(runtime, env, deliveryOptions);
    return;
  }

  writeCodexDeliveryResult(
    env,
    await runtime.services.codexDelivery.deliverPending({
      agentName: deliveryOptions.agentName,
      maxItems: deliveryOptions.maxItems,
      requestTimeoutMs: deliveryOptions.requestTimeoutMs
    })
  );
}

async function runCodexDeliveryLoop(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  options: {
    agentName: string;
    pollMs: number;
    maxItems: number;
    requestTimeoutMs: number;
    signal?: AbortSignal;
    reportResults?: boolean;
  }
): Promise<void> {
  let stopping = false;
  const stop = () => {
    stopping = true;
  };

  process.once("SIGINT", stop);
  try {
    while (!stopping && !options.signal?.aborted) {
      const result = await runtime.services.codexDelivery.deliverPending({
        agentName: options.agentName,
        maxItems: options.maxItems,
        requestTimeoutMs: options.requestTimeoutMs
      });

      if (
        options.reportResults !== false &&
        (result.attempted > 0 || result.warnings.length > 0 || result.skippedReason)
      ) {
        writeCodexDeliveryResult(env, result);
      }

      if (!stopping && !options.signal?.aborted) {
        await sleepForPoll(options.pollMs, options.signal);
      }
    }
  } finally {
    process.off("SIGINT", stop);
  }
}

async function sleepForPoll(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(ms, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      throw error;
    }
  }
}

function writeCodexDeliveryResult(env: CliExecutionEnvironment, result: CodexDeliveryResult): void {
  if (!result.supported) {
    env.io.write(`delivery: skipped (${result.skippedReason ?? "unsupported"})`);
    return;
  }

  env.io.write(
    `delivery: attempted=${result.attempted} delivered=${result.delivered} failed=${result.failed} pending=${result.pending}`
  );

  for (const warning of result.warnings) {
    env.io.write(`warning: ${warning}`);
  }
}

async function attachCodexWorker(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  options: CodexAttachOptions
): Promise<void> {
  const workers = readCodexAppServerWorkers(runtime.cwd).filter(
    (worker) =>
      worker.cwd === runtime.cwd &&
      (options.name === undefined || worker.agentName === options.name)
  );

  if (workers.length === 0) {
    throw new Error("No Codex app-server worker found. Start one with `tachikoma codex`.");
  }

  const liveWorkers: CodexAppServerWorker[] = [];
  const staleWorkers: CodexAppServerWorker[] = [];
  for (const worker of workers) {
    if (workerLifecycle(worker) === "live") {
      liveWorkers.push(worker);
    } else {
      staleWorkers.push(worker);
    }
  }

  if (staleWorkers.length > 0) {
    removeWorkers(runtime.cwd, staleWorkers);
    for (const worker of staleWorkers) {
      env.io.write(`removed stale app-server state: ${worker.agentName}`);
    }
  }

  if (liveWorkers.length === 0) {
    throw new Error("No live Codex app-server worker found. Start one with `tachikoma codex`.");
  }

  if (!options.name && liveWorkers.length > 1) {
    throw new Error(
      `tachikoma codex attach requires --name <name> when multiple Codex workers are live: ${liveWorkers
        .map((worker) => worker.agentName)
        .join(", ")}`
    );
  }

  const worker = liveWorkers[0];
  if (!worker) {
    throw new Error("No live Codex app-server worker found. Start one with `tachikoma codex`.");
  }

  env.io.write(`agent: ${worker.agentName}`);
  env.io.write(`app-server: ${worker.serverUrl}`);
  if (options.dryRun !== true && worker.sessionId) {
    recordCodexPendingHostBinding(runtime, {
      agentName: worker.agentName,
      sessionId: worker.sessionId,
      source: "tachikoma codex attach"
    });
  }
  await runCodexTuiAttach(env, worker.serverUrl, {
    dryRun: options.dryRun === true,
    agentName: worker.agentName,
    sessionId: worker.sessionId,
    role: worker.role,
    deliveryMode: "realtime"
  });
}

interface CodexTuiAttachOptions {
  dryRun?: boolean;
  agentName?: string;
  sessionId?: string;
  role?: AgentRole;
  deliveryMode?: DeliveryMode;
  configArgs?: string[];
}

async function runCodexTuiAttach(
  env: CliExecutionEnvironment,
  serverUrl: string,
  options: CodexTuiAttachOptions = {}
): Promise<void> {
  const command = codexCommandName();
  const args = [...(options.configArgs ?? []), "--remote", serverUrl];
  const launchEnv = codexTuiEnvironment(options);

  if (options.dryRun) {
    env.io.write(`attach command: ${formatShellCommand(command, args)}`);
    if (launchEnv.TACHIKOMA_AGENT_NAME) {
      env.io.write(`env: TACHIKOMA_AGENT_NAME=${launchEnv.TACHIKOMA_AGENT_NAME}`);
    }
    if (launchEnv.TACHIKOMA_SESSION_ID) {
      env.io.write(`env: TACHIKOMA_SESSION_ID=${launchEnv.TACHIKOMA_SESSION_ID}`);
    }
    if (launchEnv.TACHIKOMA_RUNTIME) {
      env.io.write(`env: TACHIKOMA_RUNTIME=${launchEnv.TACHIKOMA_RUNTIME}`);
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: launchEnv,
      stdio: "inherit"
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Codex TUI exited with signal ${signal}.`));
        return;
      }

      if (code && code !== 0) {
        reject(new Error(`Codex TUI exited with code ${code}.`));
        return;
      }

      resolve();
    });
  });
}

function codexTuiEnvironment(options: CodexTuiAttachOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(options.agentName ? { TACHIKOMA_AGENT_NAME: options.agentName } : {}),
    ...(options.sessionId ? { TACHIKOMA_SESSION_ID: options.sessionId } : {}),
    TACHIKOMA_RUNTIME: "codex",
    ...(options.role ? { TACHIKOMA_ROLE: options.role } : {}),
    ...(options.deliveryMode ? { TACHIKOMA_DELIVERY_MODE: options.deliveryMode } : {})
  };
}

function recordCodexPendingHostBinding(
  runtime: CliRuntime,
  input: { agentName: string; sessionId: string; source: string }
): void {
  recordPendingHostSessionBinding(runtime.context, {
    runtime: "codex",
    agentName: input.agentName,
    tachikomaSessionId: input.sessionId,
    source: input.source
  });
}

async function cleanupForegroundCodexWorker(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  worker: CodexAppServerWorker,
  options: { endSession?: boolean } = {}
): Promise<void> {
  if (worker.pid && isProcessAlive(worker.pid)) {
    await stopCodexAppServerPid(worker.pid);
    env.io.write(`stopped app-server: ${worker.agentName} pid=${worker.pid}`);
  } else {
    env.io.write(`stale app-server: ${worker.agentName}`);
  }

  removeWorkers(runtime.cwd, [worker]);

  if (worker.sessionId && options.endSession !== false) {
    runtime.services.sessions.end({ sessionId: worker.sessionId });
  }
}

function formatShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(formatShellToken).join(" ");
}

function formatShellToken(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : JSON.stringify(value);
}

async function ensureCodexWorker(
  runtime: CliRuntime,
  input: {
    agentName: string;
    role?: AgentRole;
    sessionId: string;
    lifecycle: CodexAppServerLifecycle;
    detached: boolean;
    port?: number;
    readyTimeoutMs?: number;
    initializeThread: boolean;
    configArgs?: string[];
  }
): Promise<CodexWorkerStartResult> {
  let existingWorker = readCodexAppServerWorkers(runtime.cwd).find(
    (worker) => worker.agentName === input.agentName && worker.cwd === runtime.cwd
  );
  let startedProcess: Awaited<ReturnType<typeof startCodexAppServerProcess>> | undefined;
  let reused = Boolean(existingWorker && workerLifecycle(existingWorker) === "live");

  if (!reused) {
    existingWorker = undefined;
    startedProcess = await startCodexAppServerProcess({
      detached: input.detached,
      port: input.port,
      readyTimeoutMs: input.readyTimeoutMs,
      env: codexTuiEnvironment({
        agentName: input.agentName,
        sessionId: input.sessionId,
        role: input.role,
        deliveryMode: "realtime"
      }),
      configArgs: input.configArgs
    });
  }

  const serverUrl = existingWorker?.serverUrl ?? startedProcess?.serverUrl;
  if (!serverUrl) {
    throw new Error("Codex app-server URL was not available.");
  }

  try {
    const managedThread = input.initializeThread
      ? await initializeCodexWorkerThread({
          serverUrl,
          cwd: runtime.cwd,
          preferredThreadId: existingWorker?.codexThreadId
        })
      : undefined;
    const worker = writeCodexAppServerWorker(runtime.cwd, {
      agentName: input.agentName,
      role: input.role,
      cwd: runtime.cwd,
      serverUrl,
      pid: existingWorker?.pid ?? startedProcess?.pid,
      startedByTachikoma: existingWorker?.startedByTachikoma ?? true,
      codexThreadId: managedThread?.thread.id,
      sessionId: input.sessionId,
      lifecycle: existingWorker?.lifecycle ?? input.lifecycle
    });

    startedProcess?.release();

    return {
      worker,
      managedThread,
      reused
    };
  } catch (error) {
    if (startedProcess) {
      await startedProcess.stop();
    }

    if (existingWorker) {
      removeCodexAppServerWorkers(runtime.cwd, {
        agentName: existingWorker.agentName,
        cwd: existingWorker.cwd
      });

      startedProcess = await startCodexAppServerProcess({
        detached: input.detached,
        port: input.port,
        readyTimeoutMs: input.readyTimeoutMs,
        env: codexTuiEnvironment({
          agentName: input.agentName,
          sessionId: input.sessionId,
          role: input.role,
          deliveryMode: "realtime"
        }),
        configArgs: input.configArgs
      });
      reused = false;

      const managedThread = input.initializeThread
        ? await initializeCodexWorkerThread({
            serverUrl: startedProcess.serverUrl,
            cwd: runtime.cwd
          })
        : undefined;
      const worker = writeCodexAppServerWorker(runtime.cwd, {
        agentName: input.agentName,
        role: input.role,
        cwd: runtime.cwd,
        serverUrl: startedProcess.serverUrl,
        pid: startedProcess.pid,
        startedByTachikoma: true,
        codexThreadId: managedThread?.thread.id,
        sessionId: input.sessionId,
        lifecycle: input.lifecycle
      });

      startedProcess.release();

      return {
        worker,
        managedThread,
        reused
      };
    }

    throw error;
  }
}

async function initializeCodexWorkerThread(input: {
  serverUrl: string;
  cwd: string;
  preferredThreadId?: string;
}): Promise<CodexManagedThread> {
  const transport = new WebSocketCodexAppServerTransport({
    url: input.serverUrl
  });
  const client = new CodexAppServerClient(transport);

  try {
    await client.initialize();
    return await client.ensureManagedThread(input.cwd, input.preferredThreadId);
  } finally {
    await transport.close();
  }
}

function writeCodexStatus(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  options: CodexStatusOptions
): void {
  const workers = readCodexAppServerWorkers(runtime.cwd).filter(
    (worker) =>
      worker.cwd === runtime.cwd &&
      (options.name === undefined || worker.agentName === options.name)
  );

  if (workers.length === 0) {
    env.io.write("codex app-server: none");
    return;
  }

  const staleWorkers: CodexAppServerWorker[] = [];

  for (const worker of workers) {
    const lifecycle = workerLifecycle(worker);
    const lifecycleLabel = lifecycle === "live" ? `live (${worker.lifecycle})` : "stale";

    env.io.write(`${worker.agentName}: ${lifecycleLabel}`);
    env.io.write(`  server: ${worker.serverUrl}`);
    env.io.write(`  pid: ${worker.pid ?? "unknown"}`);
    env.io.write(`  session: ${worker.sessionId ?? "unknown"}`);
    env.io.write(`  thread: ${worker.codexThreadId ?? "unknown"}`);
    env.io.write(`  pending messages: ${pendingDeliveryCount(runtime, worker.agentName)}`);
    env.io.write(`  started_by_tachikoma: ${worker.startedByTachikoma ? "yes" : "no"}`);

    if (lifecycle === "live") {
      env.io.write(`  attach: tachikoma codex attach --name ${worker.agentName}`);
    } else {
      staleWorkers.push(worker);
    }
  }

  if (staleWorkers.length > 0) {
    for (const worker of staleWorkers) {
      endWorkerSession(runtime, worker);
    }

    removeWorkers(runtime.cwd, staleWorkers);
    for (const worker of staleWorkers) {
      env.io.write(`removed stale app-server state: ${worker.agentName}`);
    }
  }
}

function pendingDeliveryCount(runtime: CliRuntime, agentName: string): string {
  try {
    const batch = runtime.services.delivery.collectPending({
      agentName,
      surface: "app-server"
    });

    if (!batch.supported) {
      return `0 (${batch.skippedReason ?? "delivery mode does not support app-server"})`;
    }

    return batch.directives.length.toString();
  } catch (error) {
    return `unknown (${error instanceof Error ? error.message : String(error)})`;
  }
}

async function stopCodexWorkers(
  runtime: CliRuntime,
  env: CliExecutionEnvironment,
  options: CodexStopOptions
): Promise<void> {
  if (!options.name && !options.all) {
    throw new Error("tachikoma codex stop requires --name <name> or --all.");
  }

  const workers = readCodexAppServerWorkers(runtime.cwd).filter(
    (worker) =>
      worker.cwd === runtime.cwd && (options.all === true || worker.agentName === options.name)
  );

  if (workers.length === 0) {
    env.io.write("codex app-server: none");
    return;
  }

  const removableWorkers: CodexAppServerWorker[] = [];

  for (const worker of workers) {
    if (!worker.startedByTachikoma) {
      env.io.write(`skipped: ${worker.agentName} was not started by Tachikoma`);
      continue;
    }

    if (worker.pid && isProcessAlive(worker.pid)) {
      await stopCodexAppServerPid(worker.pid);
      env.io.write(`stopped: ${worker.agentName} pid=${worker.pid}`);
    } else {
      env.io.write(`stale: ${worker.agentName}`);
    }

    if (worker.sessionId) {
      runtime.services.sessions.end({ sessionId: worker.sessionId });
    }

    removableWorkers.push(worker);
  }

  if (removableWorkers.length > 0) {
    removeWorkers(runtime.cwd, removableWorkers);
  }
}

function removeStaleCodexWorkers(runtime: CliRuntime): CodexAppServerWorker[] {
  const workers = readCodexAppServerWorkers(runtime.cwd);
  const staleWorkers = workers.filter((worker) => workerLifecycle(worker) === "stale");

  if (staleWorkers.length === 0) {
    return [];
  }

  for (const worker of staleWorkers) {
    endWorkerSession(runtime, worker);
  }

  removeWorkers(runtime.cwd, staleWorkers);
  return staleWorkers;
}

function endWorkerSession(runtime: CliRuntime, worker: CodexAppServerWorker): void {
  if (!worker.sessionId) {
    return;
  }

  runtime.services.sessions.end({ sessionId: worker.sessionId });
}

function removeWorkers(repoRoot: string, workersToRemove: CodexAppServerWorker[]): void {
  const keys = new Set(workersToRemove.map(workerKey));
  const retained = readCodexAppServerWorkers(repoRoot).filter(
    (worker) => !keys.has(workerKey(worker))
  );

  writeCodexAppServerWorkers(repoRoot, retained);
}

function workerLifecycle(worker: CodexAppServerWorker): "live" | "stale" {
  return worker.pid && isProcessAlive(worker.pid) ? "live" : "stale";
}

function workerKey(worker: CodexAppServerWorker): string {
  return `${worker.agentName}\n${worker.cwd}\n${worker.serverUrl}`;
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
