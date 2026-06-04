import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface PathResolutionOptions {
  cwd?: string;
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface TachikomaPaths {
  repoRoot: string;
  gitignorePath: string;
  projectConfigPath: string;
  tachikomaDir: string;
  agentInstructionsPath: string;
  claudeSkillPath: string;
  codexSkillPath: string;
  claudeBootSkillPath: string;
  codexBootSkillPath: string;
  claudeSyncSkillPath: string;
  codexSyncSkillPath: string;
  claudeRelaySkillPath: string;
  codexRelaySkillPath: string;
  claudeDismissSkillPath: string;
  codexDismissSkillPath: string;
  codexHooksPath: string;
  codexConfigPath: string;
  claudeSettingsLocalPath: string;
  claudeSettingsPath: string;
  mcpConfigPath: string;
  dataRoot: string;
}

export function resolveTachikomaPaths(options: PathResolutionOptions = {}): TachikomaPaths {
  const repoRoot = resolveProjectRoot(options);
  const tachikomaDir = join(repoRoot, ".tachikoma");

  return {
    repoRoot,
    gitignorePath: join(repoRoot, ".gitignore"),
    tachikomaDir,
    projectConfigPath: join(tachikomaDir, "project.toml"),
    agentInstructionsPath: join(tachikomaDir, "agent-instructions.md"),
    claudeSkillPath: join(repoRoot, ".claude", "skills", "tachikoma", "SKILL.md"),
    codexSkillPath: join(repoRoot, ".codex", "skills", "tachikoma", "SKILL.md"),
    claudeBootSkillPath: join(repoRoot, ".claude", "skills", "tachikoma-boot", "SKILL.md"),
    codexBootSkillPath: join(repoRoot, ".codex", "skills", "tachikoma-boot", "SKILL.md"),
    claudeSyncSkillPath: join(repoRoot, ".claude", "skills", "tachikoma-sync", "SKILL.md"),
    codexSyncSkillPath: join(repoRoot, ".codex", "skills", "tachikoma-sync", "SKILL.md"),
    claudeRelaySkillPath: join(repoRoot, ".claude", "skills", "tachikoma-relay", "SKILL.md"),
    codexRelaySkillPath: join(repoRoot, ".codex", "skills", "tachikoma-relay", "SKILL.md"),
    claudeDismissSkillPath: join(repoRoot, ".claude", "skills", "tachikoma-dismiss", "SKILL.md"),
    codexDismissSkillPath: join(repoRoot, ".codex", "skills", "tachikoma-dismiss", "SKILL.md"),
    codexHooksPath: join(repoRoot, ".codex", "hooks.json"),
    codexConfigPath: join(repoRoot, ".codex", "config.toml"),
    claudeSettingsLocalPath: join(repoRoot, ".claude", "settings.local.json"),
    claudeSettingsPath: join(repoRoot, ".claude", "settings.json"),
    mcpConfigPath: join(repoRoot, ".mcp.json"),
    dataRoot: resolveDataRoot(options)
  };
}

export function resolveDataRoot(options: PathResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const repoRoot = resolveProjectRoot(options);
  const rawDataRoot =
    options.dataRoot ?? env.TACHIKOMA_HOME ?? join(repoRoot, ".tachikoma", "state");

  if (isAbsolute(rawDataRoot)) {
    return rawDataRoot;
  }

  return resolve(repoRoot, rawDataRoot);
}

export function projectStorePath(dataRoot: string): string {
  return join(dataRoot, "tachikoma.sqlite");
}

/**
 * Resolve the user-global Codex config (`config.toml`) where project trust
 * levels live. Honors the `CODEX_HOME` override that Codex itself reads,
 * defaulting to `~/.codex/config.toml`.
 */
export function resolveCodexGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome =
    env.CODEX_HOME && env.CODEX_HOME.trim().length > 0 ? env.CODEX_HOME : join(homedir(), ".codex");

  return join(codexHome, "config.toml");
}

export function sanitizeProjectId(projectId: string): string {
  return projectId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function resolveProjectRoot(options: PathResolutionOptions = {}): string {
  const start = resolve(options.cwd ?? process.cwd());

  return (
    findAncestor(start, (candidate) => existsSync(join(candidate, ".tachikoma", "project.toml"))) ??
    findAncestor(start, (candidate) => existsSync(join(candidate, ".git"))) ??
    start
  );
}

function findAncestor(start: string, matches: (candidate: string) => boolean): string | undefined {
  let current = start;

  while (true) {
    if (matches(current)) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}
