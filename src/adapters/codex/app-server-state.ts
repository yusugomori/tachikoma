import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentRole } from "../../domain/types.js";

export type CodexAppServerLifecycle = "foreground" | "daemon";

export interface CodexAppServerWorker {
  agentName: string;
  role?: AgentRole;
  cwd: string;
  serverUrl: string;
  pid?: number;
  startedByTachikoma: boolean;
  codexThreadId?: string;
  sessionId?: string;
  lastTurnId?: string;
  lifecycle: CodexAppServerLifecycle;
  startedAt: string;
  updatedAt: string;
}

export interface WriteCodexAppServerWorkerInput {
  agentName: string;
  role?: AgentRole;
  cwd: string;
  serverUrl: string;
  pid?: number;
  startedByTachikoma: boolean;
  codexThreadId?: string;
  sessionId?: string;
  lastTurnId?: string;
  lifecycle: CodexAppServerLifecycle;
  startedAt?: string;
  now?: string;
}

export interface RemoveCodexAppServerWorkersFilter {
  agentName?: string;
  cwd?: string;
  all?: boolean;
}

interface CodexAppServerStateFile {
  schemaVersion: 1;
  workers: CodexAppServerWorker[];
}

export function codexAppServerStatePath(repoRoot: string): string {
  return join(repoRoot, ".tachikoma", "state", "codex-app-server.json");
}

export function readCodexAppServerWorkers(repoRoot: string): CodexAppServerWorker[] {
  return readStateFile(repoRoot).workers;
}

export function findCodexAppServerWorker(
  repoRoot: string,
  filter: { agentName: string; cwd: string }
): CodexAppServerWorker | undefined {
  return readCodexAppServerWorkers(repoRoot).find(
    (worker) => worker.agentName === filter.agentName && worker.cwd === filter.cwd
  );
}

export function writeCodexAppServerWorker(
  repoRoot: string,
  input: WriteCodexAppServerWorkerInput
): CodexAppServerWorker {
  const existing = findCodexAppServerWorker(repoRoot, {
    agentName: input.agentName,
    cwd: input.cwd
  });
  const now = input.now ?? new Date().toISOString();
  const worker: CodexAppServerWorker = {
    agentName: input.agentName,
    ...(input.role ? { role: input.role } : {}),
    cwd: input.cwd,
    serverUrl: input.serverUrl,
    ...(input.pid ? { pid: input.pid } : {}),
    startedByTachikoma: input.startedByTachikoma,
    ...(input.codexThreadId ? { codexThreadId: input.codexThreadId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
    lifecycle: input.lifecycle,
    startedAt: input.startedAt ?? existing?.startedAt ?? now,
    updatedAt: now
  };
  const workers = readCodexAppServerWorkers(repoRoot).filter(
    (candidate) => candidate.agentName !== worker.agentName || candidate.cwd !== worker.cwd
  );

  workers.push(worker);
  writeCodexAppServerWorkers(repoRoot, workers);

  return worker;
}

export function writeCodexAppServerWorkers(
  repoRoot: string,
  workers: CodexAppServerWorker[]
): void {
  writeStateFile(repoRoot, {
    schemaVersion: 1,
    workers
  });
}

export function removeCodexAppServerWorkers(
  repoRoot: string,
  filter: RemoveCodexAppServerWorkersFilter
): CodexAppServerWorker[] {
  const workers = readCodexAppServerWorkers(repoRoot);
  const removed: CodexAppServerWorker[] = [];
  const retained = workers.filter((worker) => {
    const matches =
      filter.all === true ||
      ((filter.agentName === undefined || worker.agentName === filter.agentName) &&
        (filter.cwd === undefined || worker.cwd === filter.cwd));

    if (matches) {
      removed.push(worker);
      return false;
    }

    return true;
  });

  writeCodexAppServerWorkers(repoRoot, retained);
  return removed;
}

function readStateFile(repoRoot: string): CodexAppServerStateFile {
  const path = codexAppServerStatePath(repoRoot);

  if (!existsSync(path)) {
    return emptyStateFile();
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CodexAppServerStateFile>;

    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.workers)) {
      return emptyStateFile();
    }

    return {
      schemaVersion: 1,
      workers: parsed.workers.filter(isWorker)
    };
  } catch {
    return emptyStateFile();
  }
}

function writeStateFile(repoRoot: string, file: CodexAppServerStateFile): void {
  const path = codexAppServerStatePath(repoRoot);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

function emptyStateFile(): CodexAppServerStateFile {
  return {
    schemaVersion: 1,
    workers: []
  };
}

function isWorker(value: unknown): value is CodexAppServerWorker {
  const worker = asRecord(value);

  return (
    typeof worker?.agentName === "string" &&
    (worker.role === undefined || typeof worker.role === "string") &&
    typeof worker.cwd === "string" &&
    typeof worker.serverUrl === "string" &&
    (worker.pid === undefined ||
      (typeof worker.pid === "number" && Number.isInteger(worker.pid) && worker.pid > 0)) &&
    typeof worker.startedByTachikoma === "boolean" &&
    (worker.codexThreadId === undefined || typeof worker.codexThreadId === "string") &&
    (worker.sessionId === undefined || typeof worker.sessionId === "string") &&
    (worker.lastTurnId === undefined || typeof worker.lastTurnId === "string") &&
    (worker.lifecycle === "foreground" || worker.lifecycle === "daemon") &&
    typeof worker.startedAt === "string" &&
    typeof worker.updatedAt === "string"
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
