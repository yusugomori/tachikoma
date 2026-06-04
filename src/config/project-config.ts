import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { parse } from "toml";
import { z } from "zod";

import { createId } from "../domain/ids.js";
import {
  projectStorePath,
  resolveDataRoot,
  resolveProjectRoot,
  resolveTachikomaPaths,
  sanitizeProjectId
} from "./paths.js";

export const projectConfigSchema = z.object({
  schema_version: z.number().int().positive().default(1),
  project_id: z.string().min(1),
  name: z.string().min(1),
  created_at: z.string().datetime({ offset: true }).optional()
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface CreateProjectConfigInput {
  projectId?: string;
  name: string;
  now?: string;
}

export interface ProjectRuntimeInput {
  cwd?: string;
  storePath?: string;
  projectId?: string;
  projectName?: string;
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProjectRuntimeResolution {
  cwd: string;
  dataRoot: string;
  projectConfigPath: string;
  projectConfig?: ProjectConfig;
  projectId: string;
  projectName: string;
  storePath: string;
}

export function createProjectConfig(input: CreateProjectConfigInput): ProjectConfig {
  return {
    schema_version: 1,
    project_id: input.projectId ?? createId("proj"),
    name: input.name,
    created_at: input.now ?? new Date().toISOString()
  };
}

export function projectConfigExists(repoRoot: string): boolean {
  return existsSync(resolveTachikomaPaths({ cwd: repoRoot }).projectConfigPath);
}

export function readProjectConfig(repoRoot: string): ProjectConfig | undefined {
  const path = resolveTachikomaPaths({ cwd: repoRoot }).projectConfigPath;

  if (!existsSync(path)) {
    return undefined;
  }

  return parseProjectConfig(readFileSync(path, "utf8"));
}

export function writeProjectConfig(repoRoot: string, config: ProjectConfig): void {
  const path = resolveTachikomaPaths({ cwd: repoRoot }).projectConfigPath;
  writeFileSync(path, serializeProjectConfig(config));
}

export function resolveProjectRuntime(input: ProjectRuntimeInput = {}): ProjectRuntimeResolution {
  const cwd = resolveProjectRoot({ cwd: input.cwd, env: input.env });
  const dataRoot = resolveDataRoot({
    cwd,
    dataRoot: input.dataRoot,
    env: input.env
  });
  const paths = resolveTachikomaPaths({
    cwd,
    dataRoot,
    env: input.env
  });
  const projectConfig = readProjectConfig(cwd);
  const projectId = input.projectId ?? projectConfig?.project_id ?? deriveLocalProjectId(cwd);
  const projectName = input.projectName ?? projectConfig?.name ?? basename(cwd);
  const storePath = input.storePath ? resolve(cwd, input.storePath) : projectStorePath(dataRoot);

  return {
    cwd,
    dataRoot,
    projectConfigPath: paths.projectConfigPath,
    projectConfig,
    projectId,
    projectName,
    storePath
  };
}

export function parseProjectConfig(contents: string): ProjectConfig {
  return projectConfigSchema.parse(parse(contents));
}

export function serializeProjectConfig(config: ProjectConfig): string {
  const parsed = projectConfigSchema.parse(config);
  const lines = [
    "# Tachikoma project identity. Commit-safe; machine-local state lives in .tachikoma/state.",
    `schema_version = ${parsed.schema_version}`,
    `project_id = ${tomlString(parsed.project_id)}`,
    `name = ${tomlString(parsed.name)}`
  ];

  if (parsed.created_at) {
    lines.push(`created_at = ${tomlString(parsed.created_at)}`);
  }

  return `${lines.join("\n")}\n`;
}

export function deriveLocalProjectId(cwd: string): string {
  const resolved = resolve(cwd);
  const slug = sanitizeProjectId(basename(resolved)).replace(/^_+|_+$/g, "") || "project";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);

  return `proj_${slug}_${hash}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
