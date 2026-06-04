import { existsSync, rmSync } from "node:fs";
import { relative } from "node:path";

import { codexAppServerStatePath } from "../adapters/codex/app-server-state.js";
import { codexRemoteControlBindingPath } from "../adapters/codex/remote-control-binding.js";
import { hostSessionBindingPath } from "../adapters/hooks/session-binding.js";
import { resolveProjectRuntime } from "../config/project-config.js";

export interface ResetOptions {
  cwd?: string;
  storePath?: string;
  projectId?: string;
  projectName?: string;
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export type ResetTargetKind =
  | "event-store"
  | "sqlite-wal"
  | "sqlite-shm"
  | "codex-app-server"
  | "codex-remote-control"
  | "host-sessions";

export interface ResetTarget {
  kind: ResetTargetKind;
  path: string;
  relativePath: string;
  description: string;
  present: boolean;
}

export interface ResetPlan {
  repoRoot: string;
  dataRoot: string;
  storePath: string;
  projectId: string;
  projectName: string;
  targets: ResetTarget[];
}

export interface ResetResult {
  plan: ResetPlan;
  removed: ResetTarget[];
}

export class ResetForceRequiredError extends Error {
  public readonly plan: ResetPlan;

  public constructor(plan: ResetPlan) {
    super("Reset requires force to delete local Tachikoma state.");
    this.name = "ResetForceRequiredError";
    this.plan = plan;
  }
}

export function resetStoreSiblingPaths(storePath: string): [string, string, string] {
  return [storePath, `${storePath}-wal`, `${storePath}-shm`];
}

export function planReset(options: ResetOptions = {}): ResetPlan {
  const resolution = resolveProjectRuntime({
    cwd: options.cwd,
    storePath: options.storePath,
    projectId: options.projectId,
    projectName: options.projectName,
    dataRoot: options.dataRoot,
    env: options.env
  });
  const repoRoot = resolution.cwd;
  const [storePath, walPath, shmPath] = resetStoreSiblingPaths(resolution.storePath);
  const specs: Array<{ kind: ResetTargetKind; path: string; description: string }> = [
    { kind: "event-store", path: storePath, description: "event store" },
    { kind: "sqlite-wal", path: walPath, description: "SQLite WAL" },
    { kind: "sqlite-shm", path: shmPath, description: "SQLite shared memory" },
    {
      kind: "codex-app-server",
      path: codexAppServerStatePath(repoRoot),
      description: "Codex app-server state"
    },
    {
      kind: "codex-remote-control",
      path: codexRemoteControlBindingPath(repoRoot),
      description: "Codex remote-control bindings"
    },
    {
      kind: "host-sessions",
      path: hostSessionBindingPath(repoRoot),
      description: "host session bindings"
    }
  ];
  // NOTE: these binding files are the machine-local writers under .tachikoma/state/.
  // When you add a new .tachikoma/state writer, add its path here AND update
  // test/unit/reset-service.test.ts so reset keeps clearing all session state.
  const targets: ResetTarget[] = specs.map((spec) => ({
    kind: spec.kind,
    path: spec.path,
    relativePath: relative(repoRoot, spec.path),
    description: spec.description,
    present: existsSync(spec.path)
  }));

  return {
    repoRoot,
    dataRoot: resolution.dataRoot,
    storePath: resolution.storePath,
    projectId: resolution.projectId,
    projectName: resolution.projectName,
    targets
  };
}

export function applyResetPlan(plan: ResetPlan, options: { force?: boolean } = {}): ResetResult {
  if (!options.force) {
    throw new ResetForceRequiredError(plan);
  }

  const removed: ResetTarget[] = [];

  for (const target of plan.targets) {
    // Delete only known local state files; never recurse into .tachikoma/state so
    // unrelated machine-local files are left untouched. rmSync with force is a no-op
    // for missing paths, but re-check so the removed list reflects actual deletions.
    if (!existsSync(target.path)) {
      continue;
    }

    rmSync(target.path, { force: true });
    removed.push({ ...target, present: true });
  }

  return { plan, removed };
}
