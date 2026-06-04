import type { Command } from "commander";
import {
  isTachikomaIdentityPrompt,
  parseHostHookInput,
  parseHostHookJson,
  renderHostHookOutput,
  renderUnboundIdentityContext,
  resolveBoundHostAgentName,
  runMonitorHook,
  runMonitorWatch,
  runReceiveHook,
  runSentHook,
  runSessionStartHook,
  runStopHook
} from "../../adapters/index.js";
import { ValidationError } from "../../domain/errors.js";
import type { AgentRole, AgentRuntime, DeliveryMode } from "../../domain/types.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

type HookOutputFormat = "text" | "codex-json" | "claude-json" | "auto";

interface HookSessionStartOptions {
  name?: string;
  agent?: string;
  runtime?: AgentRuntime;
  role?: AgentRole;
  deliveryMode?: DeliveryMode;
  capability?: string[];
  takeover?: boolean;
}

interface HookDeliveryOptions {
  session?: string;
  name?: string;
}

interface HookReceiveOptions extends HookDeliveryOptions {
  runtime: AgentRuntime;
  event?: string;
  format?: HookOutputFormat;
  maxItems?: string;
}

interface HookMonitorOptions extends HookDeliveryOptions {
  watch?: boolean;
  pollMs?: string;
  maxItems?: string;
  idleTimeoutMs?: string;
  once?: boolean;
}

interface HookSentOptions {
  runtime: AgentRuntime;
  name?: string;
  event?: string;
  format?: HookOutputFormat;
}

export function registerHookCommand(program: Command, env: CliExecutionEnvironment): void {
  const hook = program.command("hook").description("Run Tachikoma hook adapters.");

  hook
    .command("session-start")
    .description("Start a Tachikoma session and print compact startup context.")
    .option("--name <name>", "Registered agent endpoint name.")
    .option("--agent <agent_id>", "Registered agent endpoint id.")
    .option("--runtime <runtime>", "Runtime override.")
    .option("--role <role>", "Role override.")
    .option("--delivery-mode <mode>", "Delivery mode.", "turn")
    .option("--capability <capability>", "Presence capability.", collect, [])
    .option("--takeover", "End existing live sessions for this name before joining.")
    .action(async function (this: Command, options: HookSessionStartOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const result = runSessionStartHook(runtime.context, runtime.services, {
          name: options.name,
          agentId: options.agent,
          runtime: options.runtime,
          role: options.role,
          deliveryMode: options.deliveryMode ?? "turn",
          cwd: runtime.cwd,
          capabilities: options.capability ?? [],
          takeover: options.takeover
        });

        env.io.write(result.output);
      });
    });

  hook
    .command("stop")
    .description("Check turn-delivery messages for an active session.")
    .option("--session <session_id>", "Session id.")
    .option("--name <agent_name>", "Registered agent endpoint name.")
    .action(async function (this: Command, options: HookDeliveryOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const result = runStopHook(runtime.context, runtime.services, {
          sessionId: options.session,
          agentName: options.name
        });

        if (result.output) {
          env.io.write(result.output);
        }
      });
    });

  hook
    .command("receive")
    .description("Receive pending Tachikoma delivery for a host hook.")
    .requiredOption("--runtime <runtime>", "Host runtime: codex or claude.")
    .option("--session <session_id>", "Session id.")
    .option("--name <agent_name>", "Registered agent endpoint name.")
    .option("--event <event_name>", "Host hook event name.")
    .option("--format <format>", "Output format: text, codex-json, claude-json, auto.", "auto")
    .option("--max-items <count>", "Maximum delivered directives per hook run.", "5")
    .action(async function (this: Command, options: HookReceiveOptions) {
      await withCliRuntime(this, env, async (runtime) => {
        const host = await hostInputFromOptions(env, {
          runtime: options.runtime,
          eventName: options.event ?? "Stop"
        });
        const format = options.format ?? "auto";
        const boundAgentName = resolveBoundHostAgentName(runtime.context, host);
        let result: ReturnType<typeof runReceiveHook>;

        try {
          result = runReceiveHook(runtime.context, runtime.services, {
            sessionId: options.session ?? (boundAgentName ? undefined : host.sessionId),
            agentName: boundAgentName ?? options.name,
            surface: surfaceForEvent(host.eventName),
            maxItems: Number.parseInt(options.maxItems ?? "5", 10),
            host: hostForFormat(host, format)
          });
        } catch (error) {
          if (isMissingDeliverySession(error)) {
            const identityContext = isTachikomaIdentityPrompt(host)
              ? renderUnboundIdentityContext(runtime.context, host)
              : "";
            const output = identityContext
              ? formatContextOutput(host, format, identityContext)
              : "";

            if (output) {
              env.io.write(output);
            }
            return;
          }

          throw error;
        }

        if (result.output) {
          env.io.write(result.output);
        }
      });
    });

  hook
    .command("sent")
    .description("Collect wakeup targets after Tachikoma send/routing tools.")
    .requiredOption("--runtime <runtime>", "Host runtime: codex or claude.")
    .option("--name <agent_name>", "Registered agent endpoint name.")
    .option("--event <event_name>", "Host hook event name.", "PostToolUse")
    .option("--format <format>", "Output format: text, codex-json, claude-json, auto.", "auto")
    .action(async function (this: Command, options: HookSentOptions) {
      await withCliRuntime(this, env, async (runtime) => {
        const host = await hostInputFromOptions(env, {
          runtime: options.runtime,
          eventName: options.event ?? "PostToolUse"
        });
        const format = options.format ?? "auto";
        const result = runSentHook(runtime.context, runtime.services, {
          host
        });
        const output = result.output ? formatSentOutput(result.output, format, host) : "";

        if (output) {
          env.io.write(output);
        }
      });
    });

  hook
    .command("monitor")
    .description("Emit monitor-delivery messages for an active session.")
    .option("--session <session_id>", "Session id.")
    .option("--name <agent_name>", "Registered agent endpoint name.")
    .option("--watch", "Poll monitor delivery until interrupted.")
    .option("--poll-ms <ms>", "Watch polling interval in milliseconds.", "1000")
    .option("--max-items <count>", "Maximum delivered directives per poll.", "5")
    .option("--idle-timeout-ms <ms>", "Exit watch mode after this many idle milliseconds.")
    .option("--once", "Exit watch mode after one poll.")
    .action(async function (this: Command, options: HookMonitorOptions) {
      if (options.watch) {
        const controller = new AbortController();
        const removeSignalHandlers = installAbortSignalHandlers(controller);

        try {
          await withCliRuntime(this, env, async (runtime) => {
            await runMonitorWatch(runtime.context, runtime.services, {
              sessionId: options.session,
              agentName: options.name,
              pollMs: parsePositiveIntegerOption(options.pollMs, "--poll-ms"),
              maxItems: parsePositiveIntegerOption(options.maxItems, "--max-items"),
              idleTimeoutMs: parseOptionalNonNegativeIntegerOption(
                options.idleTimeoutMs,
                "--idle-timeout-ms"
              ),
              once: options.once,
              signal: controller.signal,
              onOutput: (output) => {
                env.io.write(output);
              }
            });
          });
        } finally {
          removeSignalHandlers();
        }
        return;
      }

      await withCliRuntime(this, env, (runtime) => {
        const result = runMonitorHook(runtime.context, runtime.services, {
          sessionId: options.session,
          agentName: options.name
        });

        if (result.output) {
          env.io.write(result.output);
        }
      });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function hostInputFromOptions(
  env: CliExecutionEnvironment,
  defaults: { runtime: AgentRuntime; eventName: string }
) {
  const stdin = env.stdin ?? (await readAvailableStdin());

  if (stdin.trim().length > 0) {
    return parseHostHookJson(stdin, {
      runtime: hostRuntime(defaults.runtime),
      eventName: defaults.eventName
    });
  }

  return parseHostHookInput(
    {},
    {
      runtime: hostRuntime(defaults.runtime),
      eventName: defaults.eventName
    }
  );
}

function hostForFormat(
  host: Awaited<ReturnType<typeof hostInputFromOptions>>,
  format: HookOutputFormat
) {
  switch (format) {
    case "text":
      return undefined;
    case "codex-json":
      return {
        ...host,
        runtime: "codex" as const
      };
    case "claude-json":
      return {
        ...host,
        runtime: "claude" as const
      };
    case "auto":
      return host;
  }
}

function formatSentOutput(
  output: string,
  format: HookOutputFormat,
  host: Awaited<ReturnType<typeof hostInputFromOptions>>
): string {
  if (format === "codex-json" || format === "claude-json") {
    return "";
  }

  if (format === "auto" && isHostPostToolUse(host)) {
    return "";
  }

  if (format === "text") {
    const parsed = JSON.parse(output) as {
      wakeableRecipients?: Array<{ inboxItemId?: string; sessionIds?: string[] }>;
    };
    const wakeableRecipients = parsed.wakeableRecipients ?? [];
    const sessionIds = new Set(
      wakeableRecipients.flatMap((recipient) => recipient.sessionIds ?? [])
    );

    return [
      `Tachikoma wakeup: ${wakeableRecipients.length} inbox item(s) for ${sessionIds.size} live session(s)`,
      ...wakeableRecipients.map(
        (recipient) =>
          `- inbox ${recipient.inboxItemId ?? "unknown"} sessions=${(recipient.sessionIds ?? []).join(",")}`
      )
    ].join("\n");
  }

  return output;
}

function formatContextOutput(
  host: Awaited<ReturnType<typeof hostInputFromOptions>>,
  format: HookOutputFormat,
  context: string
): string {
  const formattedHost = hostForFormat(host, format);

  return formattedHost
    ? renderHostHookOutput(formattedHost, {
        kind: "context",
        context
      })
    : context;
}

function isHostPostToolUse(host: Awaited<ReturnType<typeof hostInputFromOptions>>): boolean {
  return (
    (host.runtime === "codex" || host.runtime === "claude") &&
    host.eventName.toLowerCase() === "posttooluse"
  );
}

function surfaceForEvent(eventName: string) {
  return eventName.toLowerCase() === "monitor" ? "monitor" : "stop";
}

function parsePositiveIntegerOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed.toString() !== value) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function parseOptionalNonNegativeIntegerOption(
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

function hostRuntime(runtime: AgentRuntime) {
  if (runtime !== "codex" && runtime !== "claude") {
    throw new Error("Hook runtime must be codex or claude.");
  }

  return runtime;
}

function isMissingDeliverySession(error: unknown): boolean {
  return (
    error instanceof ValidationError &&
    (error.message === "No active Tachikoma session matched the delivery request." ||
      error.message === "Delivery requires a session id or agent name.")
  );
}

async function readAvailableStdin(): Promise<string> {
  if (process.stdin.isTTY || process.stdin.readableEnded) {
    return "";
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onEnd);
      clearTimeout(timer);
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve("");
    }, 25);

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onEnd);
    process.stdin.resume();
  });
}
