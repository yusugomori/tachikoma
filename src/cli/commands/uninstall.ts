import type { Command } from "commander";

import {
  applyUninstallPlan,
  planUninstall,
  type UninstallActionKind,
  type UninstallPlan
} from "../../services/index.js";
import { type CliColor, colorize, writeLines } from "../io.js";
import { type PlanItem, planContextLines, planHeading, planItemLines } from "../plan-format.js";
import { type CliExecutionEnvironment, runtimeOptionsFromCommand } from "../runtime.js";

const UNINSTALL_TOKEN_WIDTH = Math.max("delete".length, "edit".length, "skip".length);

interface UninstallCommandOptions {
  dryRun?: boolean;
  force?: boolean;
}

export function registerUninstallCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("uninstall")
    .description(
      "Remove local Tachikoma integration (state, generated skills, host hooks, MCP entry, and managed config blocks)."
    )
    .option("--dry-run", "Print the uninstall plan without removing or editing files.")
    .option("--force", "Remove Tachikoma integration from this repository.")
    .action(async function (this: Command, options: UninstallCommandOptions) {
      if (!options.dryRun && !options.force) {
        throw new Error(
          "uninstall requires --dry-run to preview or --force to remove local Tachikoma integration."
        );
      }

      if (options.dryRun && options.force) {
        throw new Error("uninstall cannot combine --dry-run and --force; choose one.");
      }

      const runtimeOptions = runtimeOptionsFromCommand(this, env);
      const plan = planUninstall({
        repoRoot: runtimeOptions.cwd,
        dataRoot: runtimeOptions.dataRoot
      });

      writeUninstallPlan(env, plan);

      const actionable = plan.targets.filter((target) => target.action !== "skip");
      const trackedCount = actionable.filter((target) => target.tracked).length;

      if (plan.externalDataRoot) {
        env.io.write(
          `note: external data root left untouched; remove manually if unused: ${plan.externalDataRoot}`
        );
      }

      if (options.dryRun) {
        env.io.write(
          `${colorize(env.io, "yellow", "dry-run")}: nothing removed (${actionable.length} target(s) to apply${
            trackedCount > 0 ? `, ${trackedCount} git-tracked` : ""
          })`
        );
        return;
      }

      const result = applyUninstallPlan(plan, { force: true });

      env.io.write(
        `${colorize(env.io, "green", "uninstall")}: applied ${result.applied.length} of ${plan.targets.length} target(s)`
      );

      if (result.removedEmptyDirs.length > 0) {
        env.io.write(`pruned empty directories: ${result.removedEmptyDirs.join(", ")}`);
      }

      env.io.write(
        "next: uninstall removed repository integration only. To remove the global CLI, run npm rm -g @yusugomori/tachikoma."
      );
    });
}

function writeUninstallPlan(env: CliExecutionEnvironment, plan: UninstallPlan): void {
  env.io.write(planHeading(env.io, "uninstall plan:"));
  writeLines(env.io, planContextLines([["repo", plan.repoRoot]]));

  env.io.write(planHeading(env.io, "targets:"));

  const items: PlanItem[] = plan.targets.map((target) => ({
    token: target.action,
    color: colorForAction(target.action),
    cells: [target.relativePath, detailForTarget(target.description, target.tracked, target.action)]
  }));

  writeLines(env.io, planItemLines(env.io, items, { tokenWidth: UNINSTALL_TOKEN_WIDTH }));
}

function detailForTarget(
  description: string,
  tracked: boolean,
  action: UninstallActionKind
): string {
  const flags = [
    tracked ? "tracked" : undefined,
    action === "edit" ? "keeps other entries" : undefined
  ]
    .filter((flag): flag is string => Boolean(flag))
    .join(", ");

  return flags.length > 0 ? `${description} [${flags}]` : description;
}

function colorForAction(action: UninstallActionKind): CliColor {
  switch (action) {
    case "delete":
      return "red";
    case "edit":
      return "yellow";
    default:
      return "cyan";
  }
}
