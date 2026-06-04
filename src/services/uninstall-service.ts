import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { claudeInstructionsPath, codexInstructionsPath } from "../adapters/index.js";
import { resolveCodexGlobalConfigPath, resolveTachikomaPaths } from "../config/paths.js";
import {
  abbreviateHomePath,
  containsTachikomaHostHook,
  removeCodexTrustBlock,
  TACHIKOMA_AGENT_DOCS_END,
  TACHIKOMA_AGENT_DOCS_START,
  TACHIKOMA_GITIGNORE_END,
  TACHIKOMA_GITIGNORE_START
} from "./install-service.js";

export type UninstallActionKind = "delete" | "edit" | "skip";

export type UninstallTargetKind =
  | "state-dir"
  | "skill-dir"
  | "host-hooks"
  | "codex-trust"
  | "mcp-config"
  | "gitignore"
  | "agent-docs";

export interface UninstallTarget {
  kind: UninstallTargetKind;
  path: string;
  relativePath: string;
  description: string;
  action: UninstallActionKind;
  tracked: boolean;
  /**
   * For `edit` actions, the rewritten file contents to write back. Undefined when
   * the action is `delete` (the path is removed) or `skip` (nothing to do).
   */
  nextContent?: string;
}

export interface UninstallPlan {
  repoRoot: string;
  targets: UninstallTarget[];
  /**
   * Set when the resolved data root lives outside the repository (TACHIKOMA_HOME
   * or --data-root). Uninstall never deletes an external/shared store; the CLI
   * surfaces this path so the operator can remove it manually if desired.
   */
  externalDataRoot?: string;
}

export interface UninstallResult {
  plan: UninstallPlan;
  applied: UninstallTarget[];
  removedEmptyDirs: string[];
}

export interface UninstallOptions {
  repoRoot?: string;
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export class UninstallForceRequiredError extends Error {
  public readonly plan: UninstallPlan;

  public constructor(plan: UninstallPlan) {
    super("Uninstall requires force to remove local Tachikoma integration.");
    this.name = "UninstallForceRequiredError";
    this.plan = plan;
  }
}

// Parent directories pruned after their Tachikoma contents are removed, but only
// when they end up empty so unrelated Claude/Codex assets are never touched.
const PRUNE_DIRS = [".claude/skills", ".codex/skills", ".claude", ".codex"];

export function planUninstall(options: UninstallOptions = {}): UninstallPlan {
  const paths = resolveTachikomaPaths({
    cwd: options.repoRoot ?? process.cwd(),
    dataRoot: options.dataRoot,
    env: options.env
  });
  const repoRoot = paths.repoRoot;
  const targets: UninstallTarget[] = [];

  // 1. Project state, store, and identity under .tachikoma/.
  targets.push(
    deletionTarget(
      repoRoot,
      paths.tachikomaDir,
      "state-dir",
      "Tachikoma state, store, and project config"
    )
  );

  // 2. Generated skill directories (one per skill, both runtimes).
  const skillDirs = [
    paths.claudeSkillPath,
    paths.claudeBootSkillPath,
    paths.claudeSyncSkillPath,
    paths.claudeRelaySkillPath,
    paths.claudeDismissSkillPath,
    paths.codexSkillPath,
    paths.codexBootSkillPath,
    paths.codexSyncSkillPath,
    paths.codexRelaySkillPath,
    paths.codexDismissSkillPath
  ].map((skillFile) => dirname(skillFile));

  for (const dir of skillDirs) {
    targets.push(deletionTarget(repoRoot, dir, "skill-dir", `generated skill (${basename(dir)})`));
  }

  // 3-4. Host hook activation merged into shared JSON config.
  targets.push(hostHookTarget(repoRoot, paths.codexHooksPath, "Codex host hooks"));
  targets.push(hostHookTarget(repoRoot, paths.claudeSettingsLocalPath, "Claude host hooks"));

  // 4b. Codex project trust entry in the user-global config.toml.
  targets.push(codexTrustTarget(repoRoot, options.env ?? process.env));

  // 5. MCP server registration.
  targets.push(mcpTarget(repoRoot, paths.mcpConfigPath));

  // 6. Managed .gitignore block.
  targets.push(
    blockTarget({
      repoRoot,
      absolutePath: paths.gitignorePath,
      kind: "gitignore",
      description: "Tachikoma .gitignore block",
      start: TACHIKOMA_GITIGNORE_START,
      end: TACHIKOMA_GITIGNORE_END
    })
  );

  // 7-8. Managed AGENTS.md / CLAUDE.md instruction blocks.
  targets.push(
    blockTarget({
      repoRoot,
      absolutePath: join(repoRoot, codexInstructionsPath),
      kind: "agent-docs",
      description: `managed instructions block (${codexInstructionsPath})`,
      start: TACHIKOMA_AGENT_DOCS_START,
      end: TACHIKOMA_AGENT_DOCS_END
    })
  );
  targets.push(
    blockTarget({
      repoRoot,
      absolutePath: join(repoRoot, claudeInstructionsPath),
      kind: "agent-docs",
      description: `managed instructions block (${claudeInstructionsPath})`,
      start: TACHIKOMA_AGENT_DOCS_START,
      end: TACHIKOMA_AGENT_DOCS_END
    })
  );

  return {
    repoRoot,
    targets,
    externalDataRoot: isInside(paths.tachikomaDir, paths.dataRoot) ? undefined : paths.dataRoot
  };
}

export function applyUninstallPlan(
  plan: UninstallPlan,
  options: { force?: boolean } = {}
): UninstallResult {
  if (!options.force) {
    throw new UninstallForceRequiredError(plan);
  }

  const applied: UninstallTarget[] = [];

  for (const target of plan.targets) {
    if (target.action === "skip") {
      continue;
    }

    if (target.action === "delete") {
      // recursive handles directories; force makes a missing path a no-op.
      rmSync(target.path, { recursive: true, force: true });
      applied.push(target);
      continue;
    }

    // edit: rewrite the file with the Tachikoma content removed.
    if (target.nextContent !== undefined) {
      writeFileSync(target.path, target.nextContent);
      applied.push(target);
    }
  }

  const removedEmptyDirs = pruneEmptyDirs(plan.repoRoot, PRUNE_DIRS);

  return { plan, applied, removedEmptyDirs };
}

function deletionTarget(
  repoRoot: string,
  absolutePath: string,
  kind: UninstallTargetKind,
  description: string
): UninstallTarget {
  const present = existsSync(absolutePath);
  const relativePath = relative(repoRoot, absolutePath);

  return {
    kind,
    path: absolutePath,
    relativePath,
    description,
    action: present ? "delete" : "skip",
    tracked: present && isGitTracked(repoRoot, relativePath)
  };
}

function hostHookTarget(
  repoRoot: string,
  absolutePath: string,
  description: string
): UninstallTarget {
  const base = jsonEditBase(repoRoot, absolutePath, description, "host-hooks");

  if (!base) {
    return skipTarget(repoRoot, absolutePath, "host-hooks", description);
  }

  const { existing, target } = base;
  const hooks = asRecord(existing.hooks);
  const nextHooks: Record<string, unknown> = {};
  let changed = false;

  for (const [eventName, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      nextHooks[eventName] = value;
      continue;
    }

    const filtered = value.filter((entry) => !containsTachikomaHostHook(entry));

    if (filtered.length !== value.length) {
      changed = true;
    }

    if (filtered.length > 0) {
      nextHooks[eventName] = filtered;
    }
  }

  if (!changed) {
    return skipTarget(repoRoot, absolutePath, "host-hooks", description);
  }

  const next: Record<string, unknown> = { ...existing };

  if (Object.keys(nextHooks).length > 0) {
    next.hooks = nextHooks;
  } else {
    delete next.hooks;
  }

  return finalizeJsonEdit(target, next);
}

function codexTrustTarget(repoRoot: string, env: NodeJS.ProcessEnv): UninstallTarget {
  const absolutePath = resolveCodexGlobalConfigPath(env);
  const description = "Codex project trust entry";
  const displayPath = abbreviateHomePath(absolutePath);

  const skip: UninstallTarget = {
    kind: "codex-trust",
    path: absolutePath,
    relativePath: displayPath,
    description,
    action: "skip",
    tracked: false
  };

  if (!existsSync(absolutePath)) {
    return skip;
  }

  let existing: string;

  try {
    existing = readFileSync(absolutePath, "utf8");
  } catch {
    return skip;
  }

  const next = removeCodexTrustBlock(existing, repoRoot);

  if (next === existing) {
    return skip;
  }

  return {
    kind: "codex-trust",
    path: absolutePath,
    relativePath: displayPath,
    description,
    action: "edit",
    tracked: false,
    nextContent: next
  };
}

function mcpTarget(repoRoot: string, absolutePath: string): UninstallTarget {
  const description = "tachikoma MCP server entry";
  const base = jsonEditBase(repoRoot, absolutePath, description, "mcp-config");

  if (!base) {
    return skipTarget(repoRoot, absolutePath, "mcp-config", description);
  }

  const { existing, target } = base;
  const mcpServers = asRecord(existing.mcpServers);

  if (!("tachikoma" in mcpServers)) {
    return skipTarget(repoRoot, absolutePath, "mcp-config", description);
  }

  const { tachikoma: _removed, ...rest } = mcpServers;
  const next: Record<string, unknown> = { ...existing };

  if (Object.keys(rest).length > 0) {
    next.mcpServers = rest;
  } else {
    delete next.mcpServers;
  }

  return finalizeJsonEdit(target, next);
}

function blockTarget(input: {
  repoRoot: string;
  absolutePath: string;
  kind: UninstallTargetKind;
  description: string;
  start: string;
  end: string;
}): UninstallTarget {
  const { repoRoot, absolutePath, kind, description, start, end } = input;

  if (!existsSync(absolutePath)) {
    return skipTarget(repoRoot, absolutePath, kind, description);
  }

  const contents = readFileSync(absolutePath, "utf8");

  if (!contents.includes(start) || !contents.includes(end)) {
    return skipTarget(repoRoot, absolutePath, kind, description);
  }

  const stripped = stripBlock(contents, start, end);
  const relativePath = relative(repoRoot, absolutePath);
  const tracked = isGitTracked(repoRoot, relativePath);

  // The block was the whole file (Tachikoma created it): remove the empty file.
  if (stripped.trim().length === 0) {
    return { kind, path: absolutePath, relativePath, description, action: "delete", tracked };
  }

  return {
    kind,
    path: absolutePath,
    relativePath,
    description,
    action: "edit",
    tracked,
    nextContent: stripped
  };
}

function jsonEditBase(
  repoRoot: string,
  absolutePath: string,
  description: string,
  kind: UninstallTargetKind
): { existing: Record<string, unknown>; target: UninstallTarget } | undefined {
  if (!existsSync(absolutePath)) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch {
    // Leave files we cannot parse untouched rather than risk clobbering them.
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  return {
    existing: parsed as Record<string, unknown>,
    target: {
      kind,
      path: absolutePath,
      relativePath: relative(repoRoot, absolutePath),
      description,
      action: "skip",
      tracked: isGitTracked(repoRoot, relative(repoRoot, absolutePath))
    }
  };
}

function finalizeJsonEdit(target: UninstallTarget, next: Record<string, unknown>): UninstallTarget {
  if (Object.keys(next).length === 0) {
    return { ...target, action: "delete", nextContent: undefined };
  }

  return { ...target, action: "edit", nextContent: `${JSON.stringify(next, null, 2)}\n` };
}

function skipTarget(
  repoRoot: string,
  absolutePath: string,
  kind: UninstallTargetKind,
  description: string
): UninstallTarget {
  return {
    kind,
    path: absolutePath,
    relativePath: relative(repoRoot, absolutePath),
    description,
    action: "skip",
    tracked: false
  };
}

function stripBlock(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return contents;
  }

  const before = contents.slice(0, startIndex).replace(/\s+$/, "");
  const after = contents.slice(endIndex + end.length).replace(/^\s+/, "");

  if (before && after) {
    return `${before}\n\n${after}\n`;
  }

  if (before) {
    return `${before}\n`;
  }

  if (after) {
    return `${after}\n`;
  }

  return "";
}

function pruneEmptyDirs(repoRoot: string, relativeDirs: string[]): string[] {
  const removed: string[] = [];

  for (const relativeDir of relativeDirs) {
    const absolute = join(repoRoot, relativeDir);

    try {
      if (
        existsSync(absolute) &&
        lstatSync(absolute).isDirectory() &&
        readdirSync(absolute).length === 0
      ) {
        rmdirSync(absolute);
        removed.push(relativeDir);
      }
    } catch {
      // Best-effort cleanup; leave the directory if it cannot be removed.
    }
  }

  return removed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);

  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isGitTracked(repoRoot: string, relativePath: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", relativePath], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}
