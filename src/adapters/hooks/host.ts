import type { HostHookInput, HostHookOutput, HostRuntime } from "./types.js";

export interface HostHookDefaults {
  runtime?: HostRuntime;
  eventName?: string;
  source?: string;
}

export function parseHostHookJson(input: string, defaults: HostHookDefaults = {}): HostHookInput {
  const trimmed = input.trim();

  if (!trimmed) {
    return parseHostHookInput({}, defaults);
  }

  let raw: unknown;

  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid host hook JSON: ${message}`);
  }

  return parseHostHookInput(raw, defaults);
}

export function parseHostHookInput(raw: unknown, defaults: HostHookDefaults = {}): HostHookInput {
  const record = asRecord(raw) ?? {};
  const tool = asRecord(record.tool);
  const runtime =
    readRuntime(record.runtime) ??
    readRuntime(record.host_runtime) ??
    readRuntime(record.hostRuntime) ??
    defaults.runtime;

  if (!runtime) {
    throw new Error("Host hook runtime must be codex or claude.");
  }

  const eventName =
    readString(record.hook_event_name) ??
    readString(record.hookEventName) ??
    readString(record.event_name) ??
    readString(record.eventName) ??
    defaults.eventName ??
    "unknown";

  return {
    runtime,
    eventName,
    sessionId: readString(record.session_id) ?? readString(record.sessionId),
    cwd: readString(record.cwd),
    toolName: readString(record.tool_name) ?? readString(record.toolName) ?? readString(tool?.name),
    toolInput: record.tool_input ?? record.toolInput ?? tool?.input,
    toolResponse: record.tool_response ?? record.toolResponse ?? tool?.response,
    stopHookActive:
      readBoolean(record.stop_hook_active) ?? readBoolean(record.stopHookActive) ?? undefined,
    source: defaults.source ?? readString(record.source),
    raw
  };
}

export function renderHostHookOutput(
  host: Pick<HostHookInput, "runtime" | "eventName">,
  output: HostHookOutput
): string {
  switch (output.kind) {
    case "noop":
      return "";
    case "continue":
      return JSON.stringify({
        decision: "block",
        reason: output.prompt
      });
    case "context":
      return renderHostContextOutput(host, output.context);
  }
}

function renderHostContextOutput(
  host: Pick<HostHookInput, "runtime" | "eventName">,
  context: string
): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: host.eventName,
      additionalContext: context
    }
  });
}

function readRuntime(value: unknown): HostRuntime | undefined {
  if (value === "codex" || value === "claude") {
    return value;
  }

  if (value === "claude-code") {
    return "claude";
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
