import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ServiceContext } from "../../services/index.js";
import type { HostHookInput, HostRuntime } from "./types.js";

interface HostSessionBindingFile {
  schemaVersion: 1;
  bindings: HostSessionBinding[];
  pendingLaunches: PendingHostSessionBinding[];
}

interface HostSessionBinding {
  runtime: HostRuntime;
  hostSessionId: string;
  agentName: string;
  updatedAt: string;
  source?: string;
}

interface PendingHostSessionBinding {
  runtime: HostRuntime;
  agentName: string;
  tachikomaSessionId: string;
  createdAt: string;
  source?: string;
}

const EMPTY_BINDINGS: HostSessionBindingFile = {
  schemaVersion: 1,
  bindings: [],
  pendingLaunches: []
};

const PENDING_LAUNCH_TTL_MS = 10 * 60 * 1000;

export function recordPendingHostSessionBinding(
  context: ServiceContext,
  input: {
    runtime: HostRuntime;
    agentName: string;
    tachikomaSessionId: string;
    source?: string;
  }
): void {
  const now = new Date().toISOString();
  const file = prunePendingLaunches(context, readBindingFile(context), now);
  const pendingLaunches = file.pendingLaunches.filter(
    (pending) => pending.tachikomaSessionId !== input.tachikomaSessionId
  );

  pendingLaunches.push({
    runtime: input.runtime,
    agentName: input.agentName,
    tachikomaSessionId: input.tachikomaSessionId,
    createdAt: now,
    source: input.source
  });

  writeBindingFile(context, {
    ...file,
    pendingLaunches
  });
}

export function resolveBoundHostAgentName(
  context: ServiceContext,
  host: HostHookInput
): string | undefined {
  const prompt = tachikomaPromptFromHostInput(host);
  const environmentName = inferAgentNameFromEnvironment(context, host.runtime);

  if (environmentName) {
    bindHostSession(context, host, environmentName);
    return environmentName;
  }

  if (!host.sessionId) {
    return prompt?.bootAgentName;
  }

  const file = prunePendingLaunches(context, readBindingFile(context), new Date().toISOString());
  const boundName = file.bindings.find(
    (binding) => binding.runtime === host.runtime && binding.hostSessionId === host.sessionId
  )?.agentName;

  if (boundName) {
    if (isLiveAgentName(context, host.runtime, boundName)) {
      return boundName;
    }

    writeBindingFile(context, {
      ...file,
      bindings: file.bindings.filter(
        (binding) => binding.runtime !== host.runtime || binding.hostSessionId !== host.sessionId
      )
    });
  }

  if (prompt?.bootAgentName) {
    bindHostSession(context, host, prompt.bootAgentName);
    return prompt.bootAgentName;
  }

  const pendingName = claimPendingHostSessionBinding(context, host);

  if (pendingName) {
    return pendingName;
  }

  if (prompt?.invoked) {
    return undefined;
  }

  return undefined;
}

export function inferAgentNameFromHostInput(host: HostHookInput): string | undefined {
  const prompt = tachikomaPromptFromHostInput(host);

  return prompt?.bootAgentName;
}

function tachikomaPromptFromHostInput(
  host: HostHookInput
): { invoked: true; boot: boolean; bootAgentName?: string } | undefined {
  const prompt = promptTextFromHostInput(host);

  if (!prompt) {
    return undefined;
  }

  const match = /(?:^|\s)(?:\/|\$)(tachikoma(?:-boot)?)(?:\s+([^\r\n]*))?/.exec(prompt);

  if (!match) {
    return undefined;
  }

  const command = match[1];

  if (!command) {
    return undefined;
  }

  const boot = command.endsWith("-boot");
  const bootAgentName = boot ? agentNameFromPromptArgs(match[2]) : undefined;

  return {
    invoked: true,
    boot,
    ...(bootAgentName ? { bootAgentName } : {})
  };
}

function inferAgentNameFromEnvironment(
  context: ServiceContext,
  runtime: HostRuntime
): string | undefined {
  const envRuntime = process.env.TACHIKOMA_RUNTIME ?? process.env.TACHIKOMA_ACTOR_RUNTIME;

  if (envRuntime && envRuntime !== runtime) {
    return undefined;
  }

  const name = (process.env.TACHIKOMA_AGENT_NAME ?? process.env.TACHIKOMA_ACTOR_NAME)?.trim();

  if (name && /^[A-Za-z0-9._-]+$/.test(name)) {
    return name;
  }

  const sessionId = (
    process.env.TACHIKOMA_SESSION_ID ?? process.env.TACHIKOMA_ACTOR_SESSION
  )?.trim();

  return sessionId ? liveAgentNameForSession(context, runtime, sessionId) : undefined;
}

function bindHostSession(context: ServiceContext, host: HostHookInput, agentName: string): void {
  if (!host.sessionId) {
    return;
  }

  const file = readBindingFile(context);
  const bindings = file.bindings.filter(
    (binding) => binding.runtime !== host.runtime || binding.hostSessionId !== host.sessionId
  );

  bindings.push({
    runtime: host.runtime,
    hostSessionId: host.sessionId,
    agentName,
    updatedAt: new Date().toISOString(),
    source: host.source
  });
  writeBindingFile(context, {
    ...file,
    bindings
  });
}

function claimPendingHostSessionBinding(
  context: ServiceContext,
  host: HostHookInput
): string | undefined {
  if (!host.sessionId) {
    return undefined;
  }

  const now = new Date().toISOString();
  const file = prunePendingLaunches(context, readBindingFile(context), now);
  const compatiblePending = file.pendingLaunches
    .filter((candidate) => candidate.runtime === host.runtime)
    .filter((candidate) => isLiveTachikomaSession(context, candidate));
  const pending = compatiblePending.length === 1 ? compatiblePending[0] : undefined;

  if (!pending) {
    writeBindingFile(context, file);
    return undefined;
  }

  const bindings = file.bindings.filter(
    (binding) => binding.runtime !== host.runtime || binding.hostSessionId !== host.sessionId
  );

  bindings.push({
    runtime: host.runtime,
    hostSessionId: host.sessionId,
    agentName: pending.agentName,
    updatedAt: now,
    source: host.source ?? pending.source
  });

  writeBindingFile(context, {
    ...file,
    bindings,
    pendingLaunches: file.pendingLaunches.filter(
      (candidate) => candidate.tachikomaSessionId !== pending.tachikomaSessionId
    )
  });

  return pending.agentName;
}

function promptTextFromHostInput(host: HostHookInput): string | undefined {
  const record = asRecord(host.raw);
  const candidates = [
    record?.prompt,
    record?.user_prompt,
    record?.userPrompt,
    record?.message,
    record?.input,
    record?.text
  ];

  return candidates.find((value): value is string => typeof value === "string" && value.length > 0);
}

function agentNameFromPromptArgs(args: string | undefined): string | undefined {
  const firstToken = args?.trim().split(/\s+/).find(Boolean);

  if (!firstToken || firstToken.includes("=")) {
    return undefined;
  }

  return /^[A-Za-z0-9._-]+$/.test(firstToken) ? firstToken : undefined;
}

function readBindingFile(context: ServiceContext): HostSessionBindingFile {
  const path = bindingPath(context);

  if (!existsSync(path)) {
    return EMPTY_BINDINGS;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HostSessionBindingFile>;

    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.bindings)) {
      return EMPTY_BINDINGS;
    }

    return {
      schemaVersion: 1,
      bindings: parsed.bindings.filter(isBinding),
      pendingLaunches: Array.isArray(parsed.pendingLaunches)
        ? parsed.pendingLaunches.filter(isPendingBinding)
        : []
    };
  } catch {
    return EMPTY_BINDINGS;
  }
}

function writeBindingFile(context: ServiceContext, file: HostSessionBindingFile): void {
  const path = bindingPath(context);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

export function hostSessionBindingPath(repoRoot: string): string {
  return join(repoRoot, ".tachikoma", "state", "host-sessions.json");
}

function bindingPath(context: ServiceContext): string {
  return hostSessionBindingPath(context.project.repoRoot ?? process.cwd());
}

function isBinding(value: unknown): value is HostSessionBinding {
  const binding = asRecord(value);

  return (
    (binding?.runtime === "codex" || binding?.runtime === "claude") &&
    typeof binding.hostSessionId === "string" &&
    typeof binding.agentName === "string" &&
    typeof binding.updatedAt === "string"
  );
}

function isPendingBinding(value: unknown): value is PendingHostSessionBinding {
  const binding = asRecord(value);

  return (
    (binding?.runtime === "codex" || binding?.runtime === "claude") &&
    typeof binding.agentName === "string" &&
    typeof binding.tachikomaSessionId === "string" &&
    typeof binding.createdAt === "string"
  );
}

function prunePendingLaunches(
  context: ServiceContext,
  file: HostSessionBindingFile,
  nowIso: string
): HostSessionBindingFile {
  const now = Date.parse(nowIso);

  return {
    ...file,
    pendingLaunches: file.pendingLaunches.filter((pending) => {
      const createdAt = Date.parse(pending.createdAt);

      return (
        Number.isFinite(createdAt) &&
        now - createdAt <= PENDING_LAUNCH_TTL_MS &&
        isLiveTachikomaSession(context, pending)
      );
    })
  };
}

function isLiveTachikomaSession(
  context: ServiceContext,
  pending: PendingHostSessionBinding
): boolean {
  const agents = context.projections().agents;
  const endpoint = agents.endpoints.find(
    (candidate) => candidate.name === pending.agentName && candidate.runtime === pending.runtime
  );

  if (!endpoint) {
    return false;
  }

  const hasPresence = agents.presence.some(
    (presence) =>
      presence.agentId === endpoint.id && presence.sessionId === pending.tachikomaSessionId
  );

  return agents.sessions.some(
    (session) =>
      session.id === pending.tachikomaSessionId &&
      session.agentId === endpoint.id &&
      !session.endedAt &&
      hasPresence
  );
}

function liveAgentNameForSession(
  context: ServiceContext,
  runtime: HostRuntime,
  sessionId: string
): string | undefined {
  const agents = context.projections().agents;
  const matches = agents.sessions
    .filter((session) => session.id === sessionId && !session.endedAt)
    .flatMap((session) => {
      const endpoint = agents.endpoints.find(
        (candidate) => candidate.id === session.agentId && candidate.runtime === runtime
      );
      const hasPresence = agents.presence.some(
        (presence) => presence.agentId === session.agentId && presence.sessionId === session.id
      );

      return endpoint && hasPresence ? [endpoint.name] : [];
    });

  return matches.length === 1 ? matches[0] : undefined;
}

function isLiveAgentName(
  context: ServiceContext,
  runtime: HostRuntime,
  agentName: string
): boolean {
  const agents = context.projections().agents;
  const endpoint = agents.endpoints.find(
    (candidate) => candidate.name === agentName && candidate.runtime === runtime
  );

  if (!endpoint) {
    return false;
  }

  return agents.sessions
    .filter((session) => session.agentId === endpoint.id && !session.endedAt)
    .some((session) =>
      agents.presence.some(
        (presence) => presence.agentId === endpoint.id && presence.sessionId === session.id
      )
    );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
