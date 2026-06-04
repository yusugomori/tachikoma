import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parse as parseToml } from "toml";
import { z } from "zod";

import {
  projectStorePath,
  resolveCodexGlobalConfigPath,
  resolveTachikomaPaths
} from "../config/paths.js";
import {
  createProjectConfig,
  type ProjectConfig,
  readProjectConfig,
  resolveProjectRuntime,
  serializeProjectConfig
} from "../config/project-config.js";
import { isTachikomaSourceCheckout } from "../config/source-checkout.js";

export type InstallWriteAction = "create" | "update" | "skip";
export type DiagnosticStatus = "ok" | "missing" | "error";
export type HostHookTarget = "codex" | "claude";
export type InstallRuntimeTarget = HostHookTarget;

export interface InstallDocumentConfig {
  relativePath: string;
  managedBlock: string;
  reason: string;
}

export interface InstallOptions {
  repoRoot?: string;
  dataRoot?: string;
  storePath?: string;
  projectId?: string;
  projectName?: string;
  force?: boolean;
  dryRun?: boolean;
  includeProjectFiles?: boolean;
  includeGitignore?: boolean;
  includeSkills?: boolean;
  includeDocs?: boolean;
  includeHostHooks?: boolean;
  includeCodexTrust?: boolean;
  hostHookTargets?: HostHookTarget[];
  runtimeTargets?: InstallRuntimeTarget[];
  includeMcp?: boolean;
  docs?: InstallDocumentConfig[];
  mcpServer?: McpServerConfig;
  now?: string;
  env?: NodeJS.ProcessEnv;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface PlannedWrite {
  path: string;
  relativePath: string;
  action: InstallWriteAction;
  reason: string;
  tracked: boolean;
  local: boolean;
  blocked: boolean;
  content: string;
}

export interface InstallPlan {
  repoRoot: string;
  dataRoot: string;
  storePath: string;
  projectConfig: ProjectConfig;
  writes: PlannedWrite[];
  blockedWrites: PlannedWrite[];
}

export interface InstallResult {
  plan: InstallPlan;
  appliedWrites: PlannedWrite[];
}

export interface DiagnosticItem {
  status: DiagnosticStatus;
  path?: string;
  message: string;
}

export interface InstallDiagnostics {
  repoRoot: string;
  dataRoot: string;
  projectId: string;
  projectName: string;
  projectConfig: DiagnosticItem;
  store: DiagnosticItem;
  codexHostHooks: DiagnosticItem;
  claudeHostHooks: DiagnosticItem;
  codexTrust: DiagnosticItem;
  codexSkill: DiagnosticItem;
  claudeSkill: DiagnosticItem;
  claudeMonitor: DiagnosticItem;
  mcpConfig: DiagnosticItem;
}

const hostHookTargetSchema = z.enum(["codex", "claude"]);
export const TACHIKOMA_GITIGNORE_START = "# tachikoma:ignore:start";
export const TACHIKOMA_GITIGNORE_END = "# tachikoma:ignore:end";
export const TACHIKOMA_AGENT_DOCS_START = "<!-- tachikoma-agent-docs:start -->";
export const TACHIKOMA_AGENT_DOCS_END = "<!-- tachikoma-agent-docs:end -->";
const TACHIKOMA_GITIGNORE_ENTRIES = [
  ".tachikoma/state/",
  ".tachikoma/reports/",
  ".mcp.json",
  ".codex/hooks.json",
  ".claude/settings.local.json",
  ".claude/skills/tachikoma/",
  ".claude/skills/tachikoma-boot/",
  ".claude/skills/tachikoma-sync/",
  ".claude/skills/tachikoma-relay/",
  ".claude/skills/tachikoma-dismiss/",
  ".codex/skills/tachikoma/",
  ".codex/skills/tachikoma-boot/",
  ".codex/skills/tachikoma-sync/",
  ".codex/skills/tachikoma-relay/",
  ".codex/skills/tachikoma-dismiss/"
];

const installOptionsSchema = z.object({
  repoRoot: z.string().optional(),
  dataRoot: z.string().optional(),
  storePath: z.string().optional(),
  projectId: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  includeProjectFiles: z.boolean().optional(),
  includeGitignore: z.boolean().optional(),
  includeSkills: z.boolean().optional(),
  includeDocs: z.boolean().optional(),
  includeHostHooks: z.boolean().optional(),
  includeCodexTrust: z.boolean().optional(),
  hostHookTargets: z.array(hostHookTargetSchema).optional(),
  runtimeTargets: z.array(hostHookTargetSchema).optional(),
  includeMcp: z.boolean().optional(),
  docs: z
    .array(
      z.object({
        relativePath: z.string().min(1),
        managedBlock: z.string().min(1),
        reason: z.string().min(1)
      })
    )
    .optional(),
  mcpServer: z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).optional()
    })
    .optional(),
  now: z.string().datetime({ offset: true }).optional(),
  env: z.record(z.string(), z.string().optional()).optional()
});

export class InstallBlockedError extends Error {
  public readonly plan: InstallPlan;

  public constructor(plan: InstallPlan) {
    super(
      [
        "Install would modify tracked Tachikoma configuration. Re-run with --force to allow:",
        ...plan.blockedWrites.map((write) => `- ${write.relativePath}`)
      ].join("\n")
    );
    this.name = "InstallBlockedError";
    this.plan = plan;
  }
}

export function planInstall(options: InstallOptions = {}): InstallPlan {
  const input = installOptionsSchema.parse(options);
  const paths = resolveTachikomaPaths({
    cwd: input.repoRoot ?? process.cwd(),
    dataRoot: input.dataRoot,
    env: input.env
  });
  const repoRoot = paths.repoRoot;
  const existingConfig = readProjectConfig(repoRoot);
  const projectConfig = resolveDesiredProjectConfig(existingConfig, {
    projectId: input.projectId,
    projectName: input.projectName,
    repoRoot,
    now: input.now
  });
  const cliCommand = tachikomaCliCommand(repoRoot);
  const docsCommand = tachikomaDocsCommand(repoRoot);
  const storePath = projectStorePath(paths.dataRoot);
  const runtimeTargets = installRuntimeTargets(input.runtimeTargets);
  const writes: PlannedWrite[] = [];

  if (input.includeProjectFiles ?? true) {
    writes.push(
      planWrite({
        repoRoot,
        absolutePath: paths.projectConfigPath,
        content: serializeProjectConfig(projectConfig),
        reason: "project identity",
        local: false,
        force: input.force ?? false
      }),
      planWrite({
        repoRoot,
        absolutePath: paths.agentInstructionsPath,
        content: renderAgentInstructions(projectConfig, docsCommand),
        reason: "shared Tachikoma agent workflow instructions",
        local: false,
        force: input.force ?? false
      })
    );
  }

  if (input.includeGitignore ?? true) {
    writes.push(
      planGitignoreWrite({
        repoRoot,
        absolutePath: paths.gitignorePath,
        force: input.force ?? false
      })
    );
  }

  if (input.includeSkills ?? true) {
    if (runtimeTargets.includes("claude")) {
      writes.push(
        planWrite({
          repoRoot,
          absolutePath: paths.claudeSkillPath,
          content: renderClaudeTachikomaSkill(cliCommand),
          reason: "Claude /tachikoma coordination skill",
          local: true,
          force: input.force ?? false
        }),
        planWrite({
          repoRoot,
          absolutePath: paths.claudeBootSkillPath,
          content: renderClaudeTachikomaBootSkill(cliCommand),
          reason: "Claude /tachikoma-boot startup skill",
          local: true,
          force: input.force ?? false
        }),
        planWrite({
          repoRoot,
          absolutePath: paths.claudeSyncSkillPath,
          content: renderClaudeTachikomaSyncSkill(cliCommand),
          reason: "Claude /tachikoma-sync synchronization skill",
          local: true,
          force: input.force ?? false
        }),
        planWrite({
          repoRoot,
          absolutePath: paths.claudeRelaySkillPath,
          content: renderClaudeTachikomaRelaySkill(cliCommand),
          reason: "Claude /tachikoma-relay messaging skill",
          local: true,
          force: input.force ?? false
        }),
        planWrite({
          repoRoot,
          absolutePath: paths.claudeDismissSkillPath,
          content: renderClaudeTachikomaDismissSkill(cliCommand),
          reason: "Claude /tachikoma-dismiss inbox cleanup skill",
          local: true,
          force: input.force ?? false
        })
      );
    }

    if (runtimeTargets.includes("codex")) {
      writes.push(
        planWrite({
          repoRoot,
          absolutePath: paths.codexSkillPath,
          content: renderCodexTachikomaSkill(cliCommand),
          reason: "Codex $tachikoma coordination skill",
          local: true,
          force: input.force ?? false
        }),
        planWrite({
          repoRoot,
          absolutePath: paths.codexBootSkillPath,
          content: renderCodexTachikomaBootSkill(cliCommand),
          reason: "Codex $tachikoma-boot startup skill",
          local: true,
          force: input.force ?? false
        }),
        planWrite({
          repoRoot,
          absolutePath: paths.codexSyncSkillPath,
          content: renderCodexTachikomaSyncSkill(cliCommand),
          reason: "Codex $tachikoma-sync synchronization skill",
          local: true,
          force: input.force ?? false
        }),
        planWrite({
          repoRoot,
          absolutePath: paths.codexRelaySkillPath,
          content: renderCodexTachikomaRelaySkill(cliCommand),
          reason: "Codex $tachikoma-relay messaging skill",
          local: true,
          force: input.force ?? false
        }),
        planWrite({
          repoRoot,
          absolutePath: paths.codexDismissSkillPath,
          content: renderCodexTachikomaDismissSkill(cliCommand),
          reason: "Codex $tachikoma-dismiss inbox cleanup skill",
          local: true,
          force: input.force ?? false
        })
      );
    }
  }

  if (input.includeHostHooks ?? false) {
    for (const target of hostHookTargets(input.hostHookTargets ?? input.runtimeTargets)) {
      if (target === "codex") {
        writes.push(
          planJsonMergeWrite({
            repoRoot,
            absolutePath: paths.codexHooksPath,
            reason: "Codex host hook activation",
            local: true,
            force: input.force ?? false,
            merge: (existing) => renderCodexHostHooks(existing, repoRoot)
          })
        );

        if (input.includeCodexTrust ?? true) {
          writes.push(
            planCodexTrustWrite({
              repoRoot,
              configPath: resolveCodexGlobalConfigPath(input.env ?? process.env),
              force: input.force ?? false
            })
          );
        }
      } else {
        writes.push(
          planJsonMergeWrite({
            repoRoot,
            absolutePath: paths.claudeSettingsLocalPath,
            reason: "Claude host hook activation",
            local: true,
            force: input.force ?? false,
            merge: (existing) => renderClaudeHostHooks(existing, repoRoot)
          })
        );
      }
    }
  }

  if (input.includeMcp ?? true) {
    writes.push(
      planJsonMergeWrite({
        repoRoot,
        absolutePath: paths.mcpConfigPath,
        reason: "local MCP server configuration",
        local: true,
        force: input.force ?? false,
        merge: (existing) =>
          renderMcpConfig(existing, input.mcpServer ?? defaultMcpServerConfig(repoRoot))
      })
    );
  }

  if (input.includeDocs ?? true) {
    for (const doc of input.docs ?? []) {
      const absolutePath = resolve(repoRoot, doc.relativePath);
      const existing = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
      writes.push(
        planWrite({
          repoRoot,
          absolutePath,
          content: upsertManagedBlock(existing, doc.managedBlock),
          reason: doc.reason,
          local: false,
          force: input.force ?? false
        })
      );
    }
  }

  const blockedWrites = writes.filter((write) => write.blocked);

  return {
    repoRoot,
    dataRoot: paths.dataRoot,
    storePath,
    projectConfig,
    writes,
    blockedWrites
  };
}

export function installTachikoma(options: InstallOptions = {}): InstallResult {
  const plan = planInstall(options);

  return applyInstallPlan(plan, options);
}

export function applyInstallPlan(plan: InstallPlan, options: InstallOptions = {}): InstallResult {
  if (plan.blockedWrites.length > 0 && !(options.force ?? false) && !(options.dryRun ?? false)) {
    throw new InstallBlockedError(plan);
  }

  const appliedWrites: PlannedWrite[] = [];

  if (!(options.dryRun ?? false)) {
    for (const write of plan.writes) {
      if (write.action === "skip") {
        continue;
      }

      mkdirSync(dirname(write.path), { recursive: true });
      writeFileSync(write.path, write.content);
      appliedWrites.push(write);
    }
  }

  return {
    plan,
    appliedWrites
  };
}

export function applyNonBlockedInstallWrites(
  plan: InstallPlan,
  options: Pick<InstallOptions, "dryRun"> = {}
): InstallResult {
  const appliedWrites: PlannedWrite[] = [];

  if (!(options.dryRun ?? false)) {
    for (const write of plan.writes) {
      if (write.blocked || write.action === "skip") {
        continue;
      }

      mkdirSync(dirname(write.path), { recursive: true });
      writeFileSync(write.path, write.content);
      appliedWrites.push(write);
    }
  }

  return {
    plan,
    appliedWrites
  };
}

export function diagnoseInstall(options: InstallOptions = {}): InstallDiagnostics {
  const input = installOptionsSchema.parse(options);
  const paths = resolveTachikomaPaths({
    cwd: input.repoRoot ?? process.cwd(),
    dataRoot: input.dataRoot,
    env: input.env
  });
  const repoRoot = paths.repoRoot;
  const runtime = resolveProjectRuntime({
    cwd: repoRoot,
    dataRoot: input.dataRoot,
    storePath: input.storePath,
    projectId: input.projectId,
    projectName: input.projectName,
    env: input.env
  });
  const projectConfig = runtime.projectConfig;
  const codexHostHooks = diagnoseHostHookConfig(paths.codexHooksPath, "Codex host hooks");
  const claudeHostHooks = diagnoseHostHookConfig(
    paths.claudeSettingsLocalPath,
    "Claude host hooks"
  );
  const mcpStatus = diagnoseMcpConfig(paths.mcpConfigPath);
  const codexConfigPath = resolveCodexGlobalConfigPath(input.env ?? process.env);

  return {
    repoRoot,
    dataRoot: runtime.dataRoot,
    projectId: runtime.projectId,
    projectName: runtime.projectName,
    projectConfig: projectConfig
      ? {
          status: "ok",
          path: paths.projectConfigPath,
          message: `${projectConfig.project_id} (${projectConfig.name})`
        }
      : {
          status: "missing",
          path: paths.projectConfigPath,
          message: "missing .tachikoma/project.toml"
        },
    store: diagnosePath(runtime.storePath, "store"),
    codexHostHooks,
    claudeHostHooks,
    codexTrust: diagnoseCodexTrust(codexConfigPath, repoRoot),
    codexSkill: diagnoseTachikomaSkill(paths.codexSkillPath, "Codex tachikoma skill"),
    claudeSkill: diagnoseTachikomaSkill(paths.claudeSkillPath, "Claude tachikoma skill"),
    claudeMonitor: diagnoseClaudeMonitorReadiness({
      claudeSkillPath: paths.claudeSkillPath,
      claudeBootSkillPath: paths.claudeBootSkillPath,
      claudeHostHookPath: paths.claudeSettingsLocalPath
    }),
    mcpConfig: mcpStatus
  };
}

function resolveDesiredProjectConfig(
  existingConfig: ProjectConfig | undefined,
  input: {
    projectId?: string;
    projectName?: string;
    repoRoot: string;
    now?: string;
  }
): ProjectConfig {
  if (!existingConfig) {
    return createProjectConfig({
      projectId: input.projectId,
      name: input.projectName ?? basename(input.repoRoot),
      now: input.now
    });
  }

  return {
    ...existingConfig,
    project_id: input.projectId ?? existingConfig.project_id,
    name: input.projectName ?? existingConfig.name
  };
}

function planJsonMergeWrite(input: {
  repoRoot: string;
  absolutePath: string;
  reason: string;
  local: boolean;
  force: boolean;
  merge: (existing: Record<string, unknown>) => Record<string, unknown>;
}): PlannedWrite {
  const existing = readJsonObjectIfPresent(input.absolutePath);
  const content = `${JSON.stringify(input.merge(existing), null, 2)}\n`;

  return planWrite({
    repoRoot: input.repoRoot,
    absolutePath: input.absolutePath,
    content,
    reason: input.reason,
    local: input.local,
    force: input.force
  });
}

function planCodexTrustWrite(input: {
  repoRoot: string;
  configPath: string;
  force: boolean;
}): PlannedWrite {
  const existing = existsSync(input.configPath) ? readFileSync(input.configPath, "utf8") : "";

  return planWrite({
    repoRoot: input.repoRoot,
    absolutePath: input.configPath,
    content: upsertCodexTrustBlock(existing, input.repoRoot),
    reason: "Codex project trust (enables host hooks and exec policies)",
    local: false,
    force: input.force,
    allowTracked: true
  });
}

/**
 * Mark `repoRoot` as a trusted Codex project inside the user-global
 * `config.toml`. Idempotent: returns the input unchanged when the project is
 * already trusted, edits the existing `[projects."<root>"]` table in place when
 * present, and appends a fresh table otherwise. Preserves surrounding comments
 * and formatting by operating on text rather than re-serializing.
 */
export function upsertCodexTrustBlock(existing: string, repoRoot: string): string {
  if (readCodexTrustLevel(existing, repoRoot) === "trusted") {
    return existing;
  }

  const header = `[projects."${escapeTomlBasicString(repoRoot)}"]`;
  const trustLine = 'trust_level = "trusted"';
  const lines = existing.length > 0 ? existing.split("\n") : [];
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    const block = [header, trustLine];
    if (lines.length === 0) {
      return `${block.join("\n")}\n`;
    }

    const needsBlank = (lines[lines.length - 1] ?? "").trim() !== "";
    return `${[...lines, ...(needsBlank ? [""] : []), ...block, ""].join("\n")}`;
  }

  let sectionEnd = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  const trustIndex = lines.findIndex(
    (line, index) => index > headerIndex && index < sectionEnd && /^\s*trust_level\s*=/.test(line)
  );

  if (trustIndex === -1) {
    lines.splice(headerIndex + 1, 0, trustLine);
  } else {
    lines[trustIndex] = trustLine;
  }

  return lines.join("\n");
}

/**
 * Remove the `[projects."<repoRoot>"]` trust table from a Codex `config.toml`,
 * leaving every other project entry and surrounding content intact. Returns the
 * input unchanged when no such table exists. Collapses the blank line left
 * behind so repeated install/uninstall cycles stay clean.
 */
export function removeCodexTrustBlock(existing: string, repoRoot: string): string {
  const header = `[projects."${escapeTomlBasicString(repoRoot)}"]`;
  const lines = existing.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    return existing;
  }

  let sectionEnd = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  const remaining = [...lines.slice(0, headerIndex), ...lines.slice(sectionEnd)];
  const text = remaining
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");

  return text.length > 0 ? `${text}\n` : "";
}

function readCodexTrustLevel(existing: string, repoRoot: string): string | undefined {
  if (existing.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = parseToml(existing) as {
      projects?: Record<string, { trust_level?: unknown } | undefined>;
    };
    const level = parsed.projects?.[repoRoot]?.trust_level;
    return typeof level === "string" ? level : undefined;
  } catch {
    return undefined;
  }
}

function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function abbreviateHomePath(absolutePath: string): string {
  const home = homedir();

  if (home && (absolutePath === home || absolutePath.startsWith(`${home}/`))) {
    return `~${absolutePath.slice(home.length)}`;
  }

  return absolutePath;
}

function planGitignoreWrite(input: {
  repoRoot: string;
  absolutePath: string;
  force: boolean;
}): PlannedWrite {
  const existing = existsSync(input.absolutePath) ? readFileSync(input.absolutePath, "utf8") : "";

  return planWrite({
    repoRoot: input.repoRoot,
    absolutePath: input.absolutePath,
    content: upsertGitignoreBlock(existing),
    reason: "ignore local Tachikoma runtime and integration artifacts",
    local: false,
    force: input.force,
    allowTracked: true
  });
}

function planWrite(input: {
  repoRoot: string;
  absolutePath: string;
  content: string;
  reason: string;
  local: boolean;
  force: boolean;
  allowTracked?: boolean;
}): PlannedWrite {
  const exists = existsSync(input.absolutePath);
  const rawRelative = relative(input.repoRoot, input.absolutePath);
  const insideRepo =
    rawRelative.length > 0 && !rawRelative.startsWith("..") && !isAbsolute(rawRelative);
  const relativePath = insideRepo ? rawRelative : abbreviateHomePath(input.absolutePath);
  const previousContent = exists ? readFileSync(input.absolutePath, "utf8") : undefined;
  const action: InstallWriteAction = exists
    ? previousContent === input.content
      ? "skip"
      : "update"
    : "create";
  const tracked = insideRepo && isGitTracked(input.repoRoot, rawRelative);
  const blocked = action !== "skip" && tracked && !input.force && !input.allowTracked;

  return {
    path: input.absolutePath,
    relativePath,
    action,
    reason: input.reason,
    tracked,
    local: input.local,
    blocked,
    content: input.content
  };
}

function readJsonObjectIfPresent(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }

  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function renderCodexHostHooks(
  existing: Record<string, unknown>,
  repoRoot: string
): Record<string, unknown> {
  return renderHostHooks(existing, hostHookEntries(repoRoot, "codex"));
}

function renderClaudeHostHooks(
  existing: Record<string, unknown>,
  repoRoot: string
): Record<string, unknown> {
  return renderHostHooks(existing, hostHookEntries(repoRoot, "claude"));
}

function renderHostHooks(
  existing: Record<string, unknown>,
  additions: Record<string, unknown[]>
): Record<string, unknown> {
  const existingHooks = asRecord(existing.hooks);
  const hooks: Record<string, unknown> = {
    ...existingHooks
  };

  for (const [eventName, eventAdditions] of Object.entries(additions)) {
    const existingEventHooks = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];

    hooks[eventName] = [
      ...existingEventHooks.filter((entry) => !containsTachikomaHostHook(entry)),
      ...eventAdditions
    ];
  }

  return {
    ...existing,
    hooks
  };
}

function hostHookEntries(repoRoot: string, runtime: HostHookTarget): Record<string, unknown[]> {
  const format = `${runtime}-json`;
  const receiveCommand = (eventName: string) =>
    tachikomaHookCommand(repoRoot, "receive", [
      "--runtime",
      runtime,
      "--format",
      format,
      "--event",
      eventName
    ]);
  const sentCommand = tachikomaHookCommand(repoRoot, "sent", [
    "--runtime",
    runtime,
    "--format",
    format,
    "--event",
    "PostToolUse"
  ]);

  return {
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact",
        hooks: [
          {
            type: "command",
            command: receiveCommand("SessionStart"),
            statusMessage: "Loading Tachikoma delivery"
          }
        ]
      }
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: receiveCommand("UserPromptSubmit")
          }
        ]
      }
    ],
    PostToolUse: [
      {
        matcher:
          "mcp__tachikoma__tachikoma_ask|mcp__tachikoma__tachikoma_reply|mcp__tachikoma__tachikoma_claim_record|mcp__tachikoma__tachikoma_review_.*|mcp__tachikoma__tachikoma_verification_record",
        hooks: [
          {
            type: "command",
            command: sentCommand,
            statusMessage: "Routing Tachikoma delivery"
          }
        ]
      }
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: receiveCommand("Stop"),
            timeout: 30
          }
        ]
      }
    ]
  };
}

function tachikomaHookCommand(repoRoot: string, hookCommand: "receive" | "sent", args: string[]) {
  const base = isTachikomaSourceCheckout(repoRoot)
    ? [
        "pnpm",
        "--dir",
        repoRoot,
        "exec",
        "node",
        "--import",
        "tsx",
        join(repoRoot, "src", "cli", "index.ts"),
        "--cwd",
        repoRoot
      ]
    : ["tachikoma", "--cwd", repoRoot];

  return [...base, "hook", hookCommand, ...args].map(shellQuote).join(" ");
}

function tachikomaCliCommand(repoRoot: string): string {
  if (isTachikomaSourceCheckout(repoRoot)) {
    return ["pnpm", "--dir", repoRoot, "tachikoma", "--cwd", repoRoot].map(shellQuote).join(" ");
  }

  return "tachikoma";
}

function tachikomaDocsCommand(repoRoot: string): string {
  return isTachikomaSourceCheckout(repoRoot) ? "pnpm tachikoma" : "tachikoma";
}

function hostHookTargets(targets: HostHookTarget[] | undefined): HostHookTarget[] {
  return targets && targets.length > 0 ? targets : ["codex", "claude"];
}

function installRuntimeTargets(
  targets: InstallRuntimeTarget[] | undefined
): InstallRuntimeTarget[] {
  return targets && targets.length > 0 ? targets : ["claude", "codex"];
}

export function containsTachikomaHostHook(value: unknown): boolean {
  const serialized = JSON.stringify(value);

  return (
    serialized.includes(" hook receive ") ||
    serialized.includes(" hook sent ") ||
    serialized.includes(" hook receive\\") ||
    serialized.includes(" hook sent\\")
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function renderMcpConfig(
  existing: Record<string, unknown>,
  server: McpServerConfig
): Record<string, unknown> {
  const mcpServers =
    existing.mcpServers &&
    typeof existing.mcpServers === "object" &&
    !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  return {
    ...existing,
    mcpServers: {
      ...mcpServers,
      tachikoma: {
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {})
      }
    }
  };
}

function defaultMcpServerConfig(repoRoot: string): McpServerConfig {
  if (isTachikomaSourceCheckout(repoRoot)) {
    return {
      command: "pnpm",
      args: ["--dir", repoRoot, "tachikoma", "mcp"],
      env: {
        TACHIKOMA_CWD: repoRoot
      }
    };
  }

  return {
    command: "tachikoma",
    args: ["mcp"],
    env: {
      TACHIKOMA_CWD: repoRoot
    }
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderAgentInstructions(config: ProjectConfig, cliCommand: string): string {
  return [
    "# Tachikoma Agent Instructions",
    "",
    `Project: ${config.name}`,
    `Project id: ${config.project_id}`,
    "",
    "When task context is needed, read shared project memory:",
    "",
    "```bash",
    `${cliCommand} memory`,
    "```",
    "",
    "Do not read memory for simple identity, sync, or relay requests.",
    "",
    "Use named agents for routing. Record structured tasks, assignments, review findings,",
    "verification results, decisions, and blockers instead of raw transcripts.",
    "",
    "Tachikoma host hooks deliver inbox work during session startup, user prompts, and stop",
    "continuations. When a hook-delivered directive appears, read it as current work, act on it,",
    "then reply or record structured state through Tachikoma.",
    ""
  ].join("\n");
}

function renderClaudeTachikomaSkill(cliCommand: string): string {
  return renderTachikomaCoordinationSkill({
    invocation: "/tachikoma",
    runtime: "claude",
    cliCommand
  });
}

function renderCodexTachikomaSkill(cliCommand: string): string {
  return renderTachikomaCoordinationSkill({
    invocation: "$tachikoma",
    runtime: "codex",
    cliCommand
  });
}

function renderClaudeTachikomaBootSkill(cliCommand: string): string {
  return renderTachikomaBootSkill({
    invocation: "/tachikoma-boot",
    runtime: "claude",
    cliCommand
  });
}

function renderCodexTachikomaBootSkill(cliCommand: string): string {
  return renderTachikomaBootSkill({
    invocation: "$tachikoma-boot",
    runtime: "codex",
    cliCommand
  });
}

function renderClaudeTachikomaSyncSkill(cliCommand: string): string {
  return renderTachikomaSyncSkill({
    invocation: "/tachikoma-sync",
    runtime: "claude",
    cliCommand
  });
}

function renderCodexTachikomaSyncSkill(cliCommand: string): string {
  return renderTachikomaSyncSkill({
    invocation: "$tachikoma-sync",
    runtime: "codex",
    cliCommand
  });
}

function renderClaudeTachikomaRelaySkill(cliCommand: string): string {
  return renderTachikomaRelaySkill({
    invocation: "/tachikoma-relay",
    runtime: "claude",
    cliCommand
  });
}

function renderCodexTachikomaRelaySkill(cliCommand: string): string {
  return renderTachikomaRelaySkill({
    invocation: "$tachikoma-relay",
    runtime: "codex",
    cliCommand
  });
}

function renderClaudeTachikomaDismissSkill(cliCommand: string): string {
  return renderTachikomaDismissSkill({
    invocation: "/tachikoma-dismiss",
    runtime: "claude",
    cliCommand
  });
}

function renderCodexTachikomaDismissSkill(cliCommand: string): string {
  return renderTachikomaDismissSkill({
    invocation: "$tachikoma-dismiss",
    runtime: "codex",
    cliCommand
  });
}

function defaultDeliveryModeForRuntime(runtime: "codex" | "claude"): "turn" | "both" {
  return runtime === "claude" ? "both" : "turn";
}

function renderClaudeMonitorCommand(cliCommand: string, agentName: string): string {
  return `${cliCommand} hook monitor --name ${agentName} --watch --poll-ms 1000 --max-items 5`;
}

function renderClaudeMonitorActivationSection(input: {
  runtime: "codex" | "claude";
  cliCommand: string;
}): string[] {
  if (input.runtime !== "claude") {
    return [];
  }

  return [
    "",
    "## Claude Monitor Activation",
    "",
    "When this session was launched by `tachikoma claude`, start a Claude Code `Monitor` tool task immediately. Do not run status, inbox, env diagnostics, or join first.",
    "If hook-delivered context includes an exact Monitor input, use that exact input.",
    "",
    "Launcher environment Monitor input, only when `TACHIKOMA_MONITOR_COMMAND` is visible:",
    "",
    "```json",
    JSON.stringify(
      {
        description: "Tachikoma delivery",
        persistent: true,
        timeout_ms: 1000,
        command: 'sh -lc "$TACHIKOMA_MONITOR_COMMAND"'
      },
      null,
      2
    ),
    "```",
    "",
    "Do not run the monitor through `Bash`, do not let it become a background Bash task, and do not tail Claude task output files.",
    "",
    "For non-launcher manual setup, use this command as the `command` field of the Monitor input after replacing `<name>`:",
    "",
    "```bash",
    renderClaudeMonitorCommand(input.cliCommand, "<name>"),
    "```",
    "",
    "Manual Monitor input shape:",
    "",
    "```json",
    JSON.stringify(
      {
        description: "Tachikoma delivery for <name>",
        persistent: true,
        timeout_ms: 1000,
        command: renderClaudeMonitorCommand(input.cliCommand, "<name>")
      },
      null,
      2
    ),
    "```",
    "",
    "Expected behavior: keep the Monitor task running and act once on each directive it emits.",
    "If the Claude Monitor tool is unavailable, say so, then fall back to `/tachikoma-sync` plus turn-hook delivery; do not claim realtime monitor delivery is active.",
    ""
  ];
}

function renderClaudeMonitorSyncFallbackSection(runtime: "codex" | "claude"): string[] {
  if (runtime !== "claude") {
    return [];
  }

  return [
    "",
    "## Claude Monitor Fallback",
    "",
    "Use this skill as the explicit fallback when Claude Monitor delivery was not activated.",
    "State that realtime monitor delivery is inactive, then read status and inbox normally.",
    ""
  ];
}

function renderTachikomaCoordinationSkill(input: {
  invocation: string;
  runtime: "codex" | "claude";
  cliCommand: string;
}): string {
  const defaultDeliveryMode = defaultDeliveryModeForRuntime(input.runtime);
  const bootInvocation = input.runtime === "claude" ? "/tachikoma-boot" : "$tachikoma-boot";
  const joinCommand = `${input.cliCommand} join <name> --runtime ${input.runtime} --role "<role>" --delivery-mode ${defaultDeliveryMode}`;
  const identityUnavailableMessage = `Tachikoma launcher identity is not visible in this skill context. If you already started with tachikoma ${input.runtime}, report this as an identity binding issue; as a temporary workaround run ${bootInvocation} <name> with the expected agent name.`;

  return [
    "---",
    "name: tachikoma",
    `description: ${yamlString(
      `Coordinate Tachikoma agent work with \`${input.invocation}\`: sync inbox, send messages to named agents, reply to Tachikoma threads, act on delivered directives, and record structured outcomes.`
    )}`,
    "---",
    "",
    "# Tachikoma",
    "",
    `Use this skill when the user invokes \`${input.invocation}\`, asks to coordinate with other Tachikoma agents, or gives you a hook-delivered Tachikoma directive.`,
    "",
    "## Coordination Workflow",
    "",
    "1. If this session was launched by `tachikoma claude` or `tachikoma codex`, it may already be joined; do not call `tachikoma_session_join` just to discover identity.",
    "2. Prefer MCP tools before shell commands.",
    "3. Use `tachikoma_status` and `tachikoma_inbox` for routine synchronization. Use `tachikoma_memory` only when task context is needed or the user explicitly asks for shared project memory.",
    "4. Treat hook-delivered directives as current work. Read the thread, sender, message, linked records, and `reply_policy` before acting.",
    "5. When `reply_policy` is `required`, call `tachikoma_reply` or `tachikoma reply`; a normal chat answer alone does not satisfy the Tachikoma reply.",
    "6. Use `tachikoma_ask` to send work or questions to a named agent, `tachikoma_reply` to answer an existing Tachikoma thread, and `tachikoma_ack` when `reply_policy` is `none`.",
    "7. Record durable outcomes through Tachikoma: `tachikoma_claim_record`, `tachikoma_review_*`, `tachikoma_verification_record`, decisions, and reports where appropriate.",
    "8. Do not use raw transcripts as the source of truth. Use Tachikoma records and projections.",
    "9. For monitor-delivered work, follow Quiet Mode. Report final user-visible results only when appropriate.",
    "",
    "## Quiet Mode",
    "",
    "Default to silent operation for monitor-delivered work and message chains.",
    "Do not narrate routine ack, message progress, waiting state, status checks, or progress tables.",
    "For `reply_policy: none`, acknowledge the inbox item and produce no user-visible progress message.",
    "Speak only for a final user-visible result, an error, an ambiguity, a loop guard, or an explicit status/verbose request.",
    "",
    "## Boot Defaults",
    "",
    `If hook-delivered context or launcher environment provides \`actorName\`, \`actorRuntime\`, and \`actorSession\`, treat that as the current Tachikoma identity. Do not call \`tachikoma_session_join\` just to discover identity.`,
    "If hook-delivered context includes `Reply identity: --as <name> --actor-runtime <runtime> --actor-session <session>`, pass those values as `actorName`, `actorRuntime`, and `actorSession` in Tachikoma MCP tool calls.",
    "If hook-delivered context says launcher identity is not bound, not visible, or ambiguous, report that diagnostic instead of replacing it with the generic fallback; do not choose among live candidates.",
    "Do not run shell commands solely to inspect `TACHIKOMA_*` variables before acting on launcher identity.",
    `If no launcher identity is visible in this skill context and the user did not provide an explicit name, stop and say exactly: \`${identityUnavailableMessage}\``,
    `You may report live ${input.runtime} candidates from tachikoma_status for diagnosis, but do not choose among multiple live sessions as the current identity.`,
    `Do not send Tachikoma messages without a resolved actor identity; otherwise they may be recorded as system. Use explicit ${bootInvocation} <name> if you need to act under a known agent name.`,
    `For \`${input.invocation}\`, do not treat the first positional argument as this session's identity; it may be a target agent in the request. Use \`${bootInvocation} <name>\` for explicit manual boot/join only.`,
    "If the name already has a live session, tell the user it is already taken and suggest a different name or an explicit takeover request.",
    "",
    "## MCP Tools",
    "",
    `- \`tachikoma_session_join\` is only for explicit manual boot. Pass the explicit \`name\`, \`runtime: "${input.runtime}"\`, and \`deliveryMode: "${defaultDeliveryMode}"\`. Do not call it just to discover launcher identity.`,
    "- `tachikoma_status` and `tachikoma_inbox` for routine synchronization. Use `tachikoma_memory` only for shared project context when needed.",
    `- \`tachikoma_ask\`, \`tachikoma_reply\`, and \`tachikoma_ack\` for agent messaging. \`ask\` defaults to \`replyPolicy: "required"\`; \`reply\` defaults to \`replyPolicy: "none"\`. When launcher context is known, always pass \`actorName\`, \`actorRuntime\`, and \`actorSession\`. If \`actorName\` is unknown, pass \`actorRuntime: "${input.runtime}"\` only when there is exactly one unambiguous live launcher session.`,
    "- For `reply_policy: required`, do not provide only a user-visible chat answer. Record the answer through `tachikoma_reply` or `tachikoma reply` first.",
    "- `tachikoma_claim_record`, `tachikoma_review_*`, and `tachikoma_verification_record` for structured state.",
    ...renderClaudeMonitorActivationSection(input),
    "",
    "CLI fallback for explicit manual boot and messaging:",
    "",
    "```bash",
    joinCommand,
    `${input.cliCommand} status`,
    `${input.cliCommand} inbox --as <agent_name>`,
    `${input.cliCommand} ask <target> "<request>"`,
    `${input.cliCommand} reply <thread_id> "<message>"`,
    `${input.cliCommand} ack <inbox_item_id>`,
    "```",
    ""
  ].join("\n");
}

function renderTachikomaSyncSkill(input: {
  invocation: string;
  runtime: "codex" | "claude";
  cliCommand: string;
}) {
  return [
    "---",
    "name: tachikoma-sync",
    `description: ${yamlString(
      `Synchronize this ${input.runtime} session with Tachikoma using \`${input.invocation}\`: read status, inbox, and hook-delivered directives without performing work.`
    )}`,
    "---",
    "",
    "# Tachikoma Sync",
    "",
    `Use this skill when the user invokes \`${input.invocation}\` or asks only to synchronize Tachikoma state.`,
    "",
    "## Sync Workflow",
    "",
    "1. Prefer MCP tools before shell commands.",
    "2. Use `tachikoma_status` for current agents, open conversations, pending inbox, review findings, and verification gaps.",
    "3. Use `tachikoma_inbox` for this agent or the requested agent name.",
    "4. Read hook-delivered directives as synchronization input. Summarize what was delivered, but do not perform implementation work from this skill.",
    "5. Use `tachikoma_memory` only when the user explicitly asks for shared project memory or task context. Do not read memory for routine identity, sync, or relay checks.",
    "6. Do not send `tachikoma_ask`, `tachikoma_reply`, or `tachikoma_ack` from this skill. Use the primary `tachikoma` skill for messaging; use `tachikoma-relay` only when the user explicitly wants the narrow send/reply-only shortcut.",
    "7. Do not record claims, reviews, verification, or decisions from this skill. Use `tachikoma` for structured state changes.",
    ...renderClaudeMonitorSyncFallbackSection(input.runtime),
    "",
    "CLI fallback:",
    "",
    "```bash",
    `${input.cliCommand} status`,
    `${input.cliCommand} inbox --as <agent_name>`,
    "```",
    ""
  ].join("\n");
}

function renderTachikomaRelaySkill(input: {
  invocation: string;
  runtime: "codex" | "claude";
  cliCommand: string;
}) {
  const coordinationInvocation = input.runtime === "claude" ? "/tachikoma" : "$tachikoma";

  return [
    "---",
    "name: tachikoma-relay",
    `description: ${yamlString(
      `Optional Tachikoma send/reply shortcut for this ${input.runtime} session with \`${input.invocation}\`: send to another agent or reply to a thread without doing the work yourself.`
    )}`,
    "---",
    "",
    "# Tachikoma Relay",
    "",
    `Use this skill when the user invokes \`${input.invocation}\` or asks only to send a Tachikoma message between agents.`,
    `The main ${coordinationInvocation} skill can also send and reply; use this relay skill only when the user asks for a narrow send/reply-only action.`,
    "",
    "## Relay Workflow",
    "",
    "1. Prefer MCP tools before shell commands.",
    "2. Use `tachikoma_ask` to open a conversation and route a request to a target agent.",
    "3. Use `tachikoma_reply` to answer an existing Tachikoma thread; pass `replyPolicy` explicitly if the reply should trigger another response.",
    "4. Use `tachikoma_ack` only when the user asks to acknowledge an inbox item without sending a conversation reply.",
    "5. Include the target agent, request body, and linked context the user supplied.",
    "6. Default to quiet operation: do not narrate intermediate relay hops, waiting state, or progress tables.",
    "7. Report ids only for direct user-invoked relay commands, final user-visible results, errors, ambiguity, loop guards, or explicit status/verbose requests.",
    "8. Do not perform the requested implementation or review work from this skill. This optional shortcut only sends or replies to messages.",
    "9. Do not record claims, reviews, verification, or decisions from this skill. Use `tachikoma` for structured state changes.",
    "",
    "CLI fallback:",
    "",
    "```bash",
    `${input.cliCommand} ask <target> "<request>"`,
    `${input.cliCommand} reply <thread_id> "<message>"`,
    `${input.cliCommand} ack <inbox_item_id>`,
    "```",
    ""
  ].join("\n");
}

function renderTachikomaDismissSkill(input: {
  invocation: string;
  runtime: "codex" | "claude";
  cliCommand: string;
}) {
  const coordination = input.runtime === "claude" ? "/tachikoma" : "$tachikoma";

  return [
    "---",
    "name: tachikoma-dismiss",
    `description: ${yamlString(
      `Dismiss this ${input.runtime} agent's stale Tachikoma inbox items with \`${input.invocation}\`: preview first, never run automatically, and avoid other agents or shared targets unless explicitly requested.`
    )}`,
    "---",
    "",
    "# Tachikoma Dismiss",
    "",
    `Use this skill only when the user invokes \`${input.invocation}\` or explicitly asks to clean up stale Tachikoma inbox items. It is a maintenance helper, not part of normal coordination.`,
    "",
    "## Dismiss Workflow",
    "",
    `1. Do not run this skill automatically during boot, monitor delivery, sync, relay, or normal \`${coordination}\` coordination. Use it only on an explicit cleanup request.`,
    "2. Prefer the CLI shown below. There is intentionally no dismiss MCP tool; do not look for `tachikoma_dismiss`.",
    "3. Determine the current Tachikoma identity from launcher or hook context when it is already known. Do not join under a fallback sample name.",
    `4. If identity is unknown and the user did not provide an explicit agent name, stop and ask the user to provide the agent name or restart with \`tachikoma ${input.runtime}\`.`,
    `5. \`${input.invocation}\` with no explicit "now" request runs a dry-run preview for this agent only.`,
    "6. Execute a real dismiss only when the user explicitly asks to clean or dismiss now.",
    "7. Do not dismiss another agent's inbox silently. For other-agent cleanup, show the exact CLI command for the human to run, or run it only after the human explicitly named that agent.",
    "8. By default dismiss only this agent's own direct items. Do not include shared role/runtime-role/broadcast items unless the user explicitly asks for shared cleanup.",
    "9. `dismiss` makes an inbox item terminal (`cancelled`) for delivery but preserves event and thread history. It does not satisfy a required reply, close conversations, or change assignments.",
    "",
    "CLI fallback:",
    "",
    "```bash",
    `${input.cliCommand} inbox dismiss --as <agent_name> --dry-run`,
    `${input.cliCommand} inbox dismiss --as <agent_name>`,
    `${input.cliCommand} inbox dismiss --as <agent_name> --include-shared --dry-run`,
    "```",
    ""
  ].join("\n");
}

function renderTachikomaBootSkill(input: {
  invocation: string;
  runtime: "codex" | "claude";
  cliCommand: string;
}): string {
  const defaultDeliveryMode = defaultDeliveryModeForRuntime(input.runtime);
  const joinCommand = `${input.cliCommand} join <name> --runtime ${input.runtime} --role "<role>" --delivery-mode ${defaultDeliveryMode}`;
  const identityUnavailableMessage = `Tachikoma launcher identity is not visible in this skill context. If you already started with tachikoma ${input.runtime}, report this as an identity binding issue; as a temporary workaround run ${input.invocation} <name> with the expected agent name.`;
  const description =
    input.runtime === "claude"
      ? `Boot this Claude session into Tachikoma with \`${input.invocation}\`: start realtime Monitor delivery from the launcher-bound identity.`
      : `Manual Tachikoma boot helper for \`${input.invocation}\`: Codex realtime receive is handled by \`tachikoma codex\`; join only with an explicit name.`;
  const usage =
    input.runtime === "claude"
      ? `Use this skill when the user invokes \`${input.invocation}\` or asks only to boot the launcher-started Claude session into Tachikoma realtime.`
      : `Use this skill only when the user invokes \`${input.invocation}\` for explicit manual boot/join. It is not required for realtime receiving from \`tachikoma codex\`.`;
  const finalBootSteps =
    input.runtime === "claude"
      ? [
          "7. When launcher identity/context is present, start the Claude Monitor task described below before any status, inbox, MCP, or diagnostic checks.",
          "8. After Monitor starts, stop booting. Use the broader `tachikoma` skill only when a delivery directive arrives."
        ]
      : [
          "7. When launched by `tachikoma codex`, realtime receiving is already handled by the Codex app-server delivery loop; `$tachikoma-boot` is not required for TUI realtime delivery.",
          "8. Report the `agent`, `session`, and `claimed` count only after an explicit manual join.",
          "9. Stop after booting. Use the broader `tachikoma` skill for inbox sync, relay, or task coordination."
        ];

  return [
    "---",
    "name: tachikoma-boot",
    `description: ${yamlString(description)}`,
    "---",
    "",
    "# Tachikoma Boot",
    "",
    usage,
    "",
    "## Boot Workflow",
    "",
    `1. If hook-delivered context or environment says this session was launched by \`tachikoma ${input.runtime}\`, trust that launcher identity as already joined; do not run shell commands to inspect \`TACHIKOMA_*\`, do not call status or inbox just to confirm it, do not call \`tachikoma_session_join\` just to discover identity, and do not switch to a fallback sample name.`,
    "   If hook-delivered context includes `Reply identity: --as <name> --actor-runtime <runtime> --actor-session <session>`, pass those values as `actorName`, `actorRuntime`, and `actorSession` in Tachikoma MCP tool calls.",
    "   If hook-delivered context says launcher identity is not bound, not visible, or ambiguous, report that diagnostic instead of replacing it with the generic fallback; do not choose among live candidates.",
    `2. If launcher identity/context is unavailable and the user did not provide an explicit name, stop and say exactly: \`${identityUnavailableMessage}\``,
    `   Do not send Tachikoma messages without a resolved actor identity; otherwise they may be recorded as system. Use explicit ${input.invocation} <name> if you need to act under a known agent name.`,
    `   You may report live ${input.runtime} candidates from tachikoma_status for diagnosis, but do not choose among multiple live sessions as the current identity.`,
    "3. Only when the user provides an explicit name, treat the first positional argument as the agent name and the second as the role.",
    `4. For explicit manual boot only, prefer the Tachikoma MCP tool \`tachikoma_session_join\` with that explicit \`name\`, \`runtime: "${input.runtime}"\`, and \`deliveryMode: "${defaultDeliveryMode}"\`.`,
    `5. If MCP is unavailable and explicit manual join is needed, run the equivalent shell command with \`${input.cliCommand} join <name>\`.`,
    "6. If Tachikoma reports that the explicit name already has a live session and no launcher session id is set, tell the user the name is already taken and suggest rerunning with a different name or an explicit takeover request.",
    ...finalBootSteps,
    ...renderClaudeMonitorActivationSection(input),
    "",
    "CLI fallback for explicit manual boot only:",
    "",
    "```bash",
    joinCommand,
    "```",
    ""
  ].join("\n");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function upsertManagedBlock(contents: string, block: string): string {
  const normalizedBlock = block.endsWith("\n") ? block : `${block}\n`;
  const start = TACHIKOMA_AGENT_DOCS_START;
  const end = TACHIKOMA_AGENT_DOCS_END;
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const suffix = contents.slice(endIndex + end.length).replace(/^(?:\r?\n)+/, "");
    const next = `${contents.slice(0, startIndex)}${normalizedBlock}${suffix}`;
    return next.endsWith("\n") ? next : `${next}\n`;
  }

  if (contents.trim().length === 0) {
    return normalizedBlock;
  }

  return `${contents.trimEnd()}\n\n${normalizedBlock}`;
}

function upsertGitignoreBlock(contents: string): string {
  const block = renderGitignoreBlock();
  const startIndex = contents.indexOf(TACHIKOMA_GITIGNORE_START);
  const endIndex = contents.indexOf(TACHIKOMA_GITIGNORE_END);
  const withoutExistingBlock =
    startIndex !== -1 && endIndex !== -1 && endIndex > startIndex
      ? `${contents.slice(0, startIndex)}${contents.slice(
          endIndex + TACHIKOMA_GITIGNORE_END.length
        )}`
      : contents;
  const managedEntries = new Set(TACHIKOMA_GITIGNORE_ENTRIES);
  const filteredLines = withoutExistingBlock.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();

    return !managedEntries.has(trimmed);
  });
  const cleaned = trimTrailingBlankLines(filteredLines).join("\n").trimEnd();

  return `${cleaned}${cleaned.length > 0 ? "\n\n" : ""}${block}`;
}

function renderGitignoreBlock(): string {
  return [
    TACHIKOMA_GITIGNORE_START,
    "# Tachikoma local runtime and generated integration",
    ...TACHIKOMA_GITIGNORE_ENTRIES,
    TACHIKOMA_GITIGNORE_END,
    ""
  ].join("\n");
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const next = [...lines];

  while (next.length > 0) {
    const last = next[next.length - 1];

    if (last === undefined || last.trim().length > 0) {
      break;
    }

    next.pop();
  }

  return next;
}

function diagnosePath(path: string, label: string): DiagnosticItem {
  if (!existsSync(path)) {
    return {
      status: "missing",
      path,
      message: `missing ${label}`
    };
  }

  try {
    const stat = statSync(path);

    if (!stat.isFile()) {
      return {
        status: "error",
        path,
        message: `${label} path is not a file`
      };
    }

    return {
      status: "ok",
      path,
      message: `${label} present`
    };
  } catch (error) {
    return {
      status: "error",
      path,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function diagnoseMcpConfig(path: string): DiagnosticItem {
  if (!existsSync(path)) {
    return {
      status: "missing",
      path,
      message: "missing MCP config"
    };
  }

  try {
    const existing = readJsonObjectIfPresent(path);
    const mcpServers = existing.mcpServers;
    const hasTachikoma =
      !!mcpServers &&
      typeof mcpServers === "object" &&
      !Array.isArray(mcpServers) &&
      "tachikoma" in mcpServers;

    if (!hasTachikoma) {
      return {
        status: "missing",
        path,
        message: "missing tachikoma MCP server"
      };
    }

    return {
      status: "ok",
      path,
      message: "tachikoma MCP server configured"
    };
  } catch (error) {
    return {
      status: "error",
      path,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function diagnoseCodexTrust(path: string, repoRoot: string): DiagnosticItem {
  if (!existsSync(path)) {
    return {
      status: "missing",
      path,
      message: "codex config.toml not found; project not trusted"
    };
  }

  try {
    const level = readCodexTrustLevel(readFileSync(path, "utf8"), repoRoot);

    if (level === "trusted") {
      return {
        status: "ok",
        path,
        message: "project trusted (host hooks and exec policies enabled)"
      };
    }

    return {
      status: "missing",
      path,
      message: level
        ? `project trust_level is "${level}", not "trusted"`
        : "project not registered as trusted; host hooks and exec policies disabled"
    };
  } catch (error) {
    return {
      status: "error",
      path,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function diagnoseHostHookConfig(path: string, label: string): DiagnosticItem {
  if (!existsSync(path)) {
    return {
      status: "missing",
      path,
      message: `missing ${label}`
    };
  }

  try {
    const existing = readJsonObjectIfPresent(path);

    if (!containsTachikomaHostHook(existing)) {
      return {
        status: "missing",
        path,
        message: `missing Tachikoma ${label}`
      };
    }

    return {
      status: "ok",
      path,
      message: `${label} configured`
    };
  } catch (error) {
    return {
      status: "error",
      path,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function diagnoseTachikomaSkill(path: string, label: string): DiagnosticItem {
  if (!existsSync(path)) {
    return {
      status: "missing",
      path,
      message: `missing ${label}`
    };
  }

  try {
    const contents = readFileSync(path, "utf8");

    if (
      contents.includes("Coordinate Tachikoma agent work") &&
      contents.includes("hook-delivered directives") &&
      contents.includes("tachikoma_ask") &&
      contents.includes("tachikoma_reply")
    ) {
      return {
        status: "ok",
        path,
        message: `${label} is a coordination entrypoint`
      };
    }

    return {
      status: "error",
      path,
      message: `${label} is not the broad coordination skill; rerun install`
    };
  } catch (error) {
    return {
      status: "error",
      path,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function diagnoseClaudeMonitorReadiness(input: {
  claudeSkillPath: string;
  claudeBootSkillPath: string;
  claudeHostHookPath: string;
}): DiagnosticItem {
  const skill = diagnoseClaudeMonitorSkill(input.claudeSkillPath, "Claude tachikoma skill");

  if (skill.status !== "ok") {
    return skill;
  }

  const bootSkill = diagnoseClaudeMonitorSkill(
    input.claudeBootSkillPath,
    "Claude tachikoma-boot skill"
  );

  if (bootSkill.status !== "ok") {
    return bootSkill;
  }

  const hostHooks = diagnoseHostHookConfig(input.claudeHostHookPath, "Claude host hooks");

  if (hostHooks.status !== "ok") {
    return {
      status: hostHooks.status,
      path: hostHooks.path,
      message: `Claude monitor missing host hooks: ${hostHooks.message}`
    };
  }

  return {
    status: "ok",
    path: input.claudeSkillPath,
    message: "Claude monitor startup instructions and host hooks configured"
  };
}

function diagnoseClaudeMonitorSkill(path: string, label: string): DiagnosticItem {
  if (!existsSync(path)) {
    return {
      status: "missing",
      path,
      message: `missing ${label} monitor startup instructions`
    };
  }

  try {
    const contents = readFileSync(path, "utf8");
    const hasMonitorInstruction =
      contents.includes("Claude Monitor Activation") &&
      contents.includes('deliveryMode: "both"') &&
      contents.includes("hook monitor --name <name> --watch --poll-ms 1000 --max-items 5") &&
      contents.includes("If the Claude Monitor tool is unavailable");

    if (!hasMonitorInstruction) {
      return {
        status: "error",
        path,
        message: `${label} missing Claude monitor startup instructions; rerun install`
      };
    }

    return {
      status: "ok",
      path,
      message: `${label} contains Claude monitor startup instructions`
    };
  } catch (error) {
    return {
      status: "error",
      path,
      message: error instanceof Error ? error.message : String(error)
    };
  }
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
