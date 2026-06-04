import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CodexProbeThreadOrigin } from "./app-server-client.js";

interface CodexRemoteControlBindingFile {
  schemaVersion: 1;
  bindings: CodexRemoteControlBinding[];
}

export interface CodexRemoteControlBinding {
  agentName: string;
  codexThreadId: string;
  cwd: string;
  threadOrigin: CodexProbeThreadOrigin;
  lastTurnId?: string;
  updatedAt: string;
}

export interface WriteCodexRemoteControlBindingInput {
  agentName: string;
  codexThreadId: string;
  cwd: string;
  threadOrigin: CodexProbeThreadOrigin;
  lastTurnId?: string;
  now?: string;
}

const EMPTY_BINDINGS: CodexRemoteControlBindingFile = {
  schemaVersion: 1,
  bindings: []
};

export function readCodexRemoteControlBindings(repoRoot: string): CodexRemoteControlBinding[] {
  const file = readBindingFile(repoRoot);

  return file.bindings;
}

export function writeCodexRemoteControlBinding(
  repoRoot: string,
  input: WriteCodexRemoteControlBindingInput
): CodexRemoteControlBinding {
  const file = readBindingFile(repoRoot);
  const binding: CodexRemoteControlBinding = {
    agentName: input.agentName,
    codexThreadId: input.codexThreadId,
    cwd: input.cwd,
    threadOrigin: input.threadOrigin,
    lastTurnId: input.lastTurnId,
    updatedAt: input.now ?? new Date().toISOString()
  };
  const bindings = file.bindings.filter(
    (candidate) => candidate.agentName !== binding.agentName || candidate.cwd !== binding.cwd
  );

  bindings.push(binding);
  writeBindingFile(repoRoot, {
    schemaVersion: 1,
    bindings
  });

  return binding;
}

export function codexRemoteControlBindingPath(repoRoot: string): string {
  return join(repoRoot, ".tachikoma", "state", "codex-remote-control.json");
}

function readBindingFile(repoRoot: string): CodexRemoteControlBindingFile {
  const path = codexRemoteControlBindingPath(repoRoot);

  if (!existsSync(path)) {
    return EMPTY_BINDINGS;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CodexRemoteControlBindingFile>;

    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.bindings)) {
      return EMPTY_BINDINGS;
    }

    return {
      schemaVersion: 1,
      bindings: parsed.bindings.filter(isBinding)
    };
  } catch {
    return EMPTY_BINDINGS;
  }
}

function writeBindingFile(repoRoot: string, file: CodexRemoteControlBindingFile): void {
  const path = codexRemoteControlBindingPath(repoRoot);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

function isBinding(value: unknown): value is CodexRemoteControlBinding {
  const binding = asRecord(value);

  return (
    typeof binding?.agentName === "string" &&
    typeof binding.codexThreadId === "string" &&
    typeof binding.cwd === "string" &&
    (binding.threadOrigin === "existing" || binding.threadOrigin === "started") &&
    (binding.lastTurnId === undefined || typeof binding.lastTurnId === "string") &&
    typeof binding.updatedAt === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
