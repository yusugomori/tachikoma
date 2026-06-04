import { type Command, Option } from "commander";

import {
  claudeInstructionsPath,
  codexInstructionsPath,
  renderClaudeAgentInstructionsBlock,
  renderCodexAgentInstructionsBlock
} from "../../adapters/index.js";
import { isTachikomaSourceCheckout } from "../../config/source-checkout.js";
import {
  applyInstallPlan,
  type HostHookTarget,
  InstallBlockedError,
  type PlannedWrite,
  planInstall
} from "../../services/index.js";
import { colorize, writeLines } from "../io.js";
import { type PlanItem, planContextLines, planHeading, planItemLines } from "../plan-format.js";
import { type CliExecutionEnvironment, runtimeOptionsFromCommand } from "../runtime.js";

const INSTALL_TOKEN_WIDTH = Math.max("create".length, "update".length, "skip".length);

interface InstallCommandOptions {
  all?: boolean;
  projectId?: string;
  name?: string;
  force?: boolean;
  dryRun?: boolean;
  docs?: boolean;
  hostHooks?: boolean;
  codexTrust?: boolean;
  mcp?: boolean;
  runtime?: "codex" | "claude";
  skills?: boolean;
}

export function registerInstallCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("install")
    .description("Install Tachikoma into a target repository without overwriting tracked config.")
    .option("--project-id <project_id>", "Project id to write to .tachikoma/project.toml.")
    .option("--name <name>", "Project display name.")
    .option("--dry-run", "Print the install plan without writing files.")
    .option("--force", "Allow writes to tracked Tachikoma integration files.")
    .option("--skills", "Only regenerate generated Tachikoma skills.")
    .addOption(
      new Option(
        "--runtime <runtime>",
        "Limit runtime-specific generated skills and host hooks."
      ).choices(["codex", "claude"])
    )
    .option("--all", "Install runtime-specific integration for all supported runtimes.")
    .option("--no-docs", "Skip managed AGENTS.md and CLAUDE.md blocks.")
    .option("--no-host-hooks", "Skip Codex and Claude host hook activation files.")
    .option(
      "--no-codex-trust",
      "Skip registering this project as trusted in the user-global Codex config.toml."
    )
    .option("--no-mcp", "Skip .mcp.json.")
    .action(async function (this: Command, options: InstallCommandOptions) {
      const runtimeOptions = runtimeOptionsFromCommand(this, env);
      const repoRoot = runtimeOptions.cwd ?? process.cwd();
      const docsCommand = tachikomaDocsCommand(repoRoot);
      const installOptions = {
        repoRoot,
        dataRoot: runtimeOptions.dataRoot,
        projectId: options.projectId ?? runtimeOptions.projectId,
        projectName: options.name ?? runtimeOptions.projectName,
        force: options.force,
        dryRun: options.dryRun,
        includeProjectFiles: options.skills ? false : undefined,
        includeGitignore: options.skills ? false : undefined,
        includeSkills: true,
        includeDocs: options.skills ? false : options.docs,
        includeHostHooks: options.skills ? false : options.hostHooks !== false,
        includeCodexTrust: options.skills ? false : options.codexTrust !== false,
        runtimeTargets: runtimeTargetsFromOptions(options),
        includeMcp: options.skills ? false : options.mcp,
        docs: [
          {
            relativePath: codexInstructionsPath,
            managedBlock: renderCodexAgentInstructionsBlock(docsCommand),
            reason: "Codex managed instructions block"
          },
          {
            relativePath: claudeInstructionsPath,
            managedBlock: renderClaudeAgentInstructionsBlock(docsCommand),
            reason: "Claude managed instructions block"
          }
        ]
      };
      const plan = planInstall(installOptions);

      writeInstallPlan(env, plan.writes, {
        projectId: plan.projectConfig.project_id,
        projectName: plan.projectConfig.name,
        storePath: plan.storePath,
        dataRoot: plan.dataRoot
      });

      try {
        const result = applyInstallPlan(plan, installOptions);

        if (options.dryRun) {
          env.io.write(`${colorize(env.io, "yellow", "dry-run")}: no files written`);
          return;
        }

        env.io.write(`applied writes: ${result.appliedWrites.length}`);
      } catch (error) {
        if (error instanceof InstallBlockedError) {
          env.io.error("blocked tracked config writes:");
          for (const write of error.plan.blockedWrites) {
            env.io.error(`- ${write.relativePath}`);
          }
        }

        throw error;
      }
    });
}

function runtimeTargetsFromOptions(options: InstallCommandOptions): HostHookTarget[] | undefined {
  if (options.all) {
    return ["codex", "claude"];
  }

  return options.runtime ? [options.runtime] : undefined;
}

function tachikomaDocsCommand(repoRoot: string): string {
  return isTachikomaSourceCheckout(repoRoot) ? "pnpm tachikoma" : "tachikoma";
}

function writeInstallPlan(
  env: CliExecutionEnvironment,
  writes: PlannedWrite[],
  metadata: {
    projectId: string;
    projectName: string;
    storePath: string;
    dataRoot: string;
  }
): void {
  env.io.write(planHeading(env.io, "install plan:"));
  writeLines(
    env.io,
    planContextLines([
      ["project", `${metadata.projectId} (${metadata.projectName})`],
      ["data root", metadata.dataRoot],
      ["store", metadata.storePath]
    ])
  );

  env.io.write(planHeading(env.io, "writes:"));

  const items: PlanItem[] = writes.map((write) => ({
    token: write.action,
    color: colorForInstallWrite(write),
    cells: [write.relativePath, installWriteDetail(write)]
  }));

  writeLines(env.io, planItemLines(env.io, items, { tokenWidth: INSTALL_TOKEN_WIDTH }));
}

function installWriteDetail(write: PlannedWrite): string {
  const flags = [
    write.tracked ? "tracked" : undefined,
    write.local ? "local" : "commit-safe",
    write.blocked ? "blocked" : undefined
  ]
    .filter((flag): flag is string => Boolean(flag))
    .join(", ");

  return `${write.reason} [${flags}]`;
}

function colorForInstallWrite(write: PlannedWrite): "green" | "yellow" | "cyan" {
  if (write.blocked) {
    return "yellow";
  }

  return write.action === "skip" ? "cyan" : "green";
}
