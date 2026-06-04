import type { Command } from "commander";

import { applyResetPlan, planReset, type ResetPlan } from "../../services/index.js";
import { colorize, writeLines } from "../io.js";
import { type PlanItem, planContextLines, planHeading, planItemLines } from "../plan-format.js";
import {
  type CliExecutionEnvironment,
  openCliRuntime,
  runtimeOptionsFromCommand
} from "../runtime.js";

const RESET_TOKEN_WIDTH = Math.max("delete".length, "skip".length);

interface ResetCommandOptions {
  dryRun?: boolean;
  force?: boolean;
}

export function registerResetCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("reset")
    .description("Delete local Tachikoma runtime state and recreate an empty initialized store.")
    .option("--dry-run", "Print the reset plan without deleting files or recreating the store.")
    .option("--force", "Delete local state targets and recreate an initialized empty store.")
    .action(async function (this: Command, options: ResetCommandOptions) {
      if (!options.dryRun && !options.force) {
        throw new Error(
          "reset requires --dry-run to preview or --force to delete local Tachikoma state."
        );
      }

      if (options.dryRun && options.force) {
        throw new Error("reset cannot combine --dry-run and --force; choose one.");
      }

      const runtimeOptions = runtimeOptionsFromCommand(this, env);
      const plan = planReset({
        cwd: runtimeOptions.cwd,
        storePath: runtimeOptions.storePath,
        projectId: runtimeOptions.projectId,
        projectName: runtimeOptions.projectName,
        dataRoot: runtimeOptions.dataRoot
      });

      writeResetPlan(env, plan);

      const deleteCount = plan.targets.filter((target) => target.present).length;
      const skipCount = plan.targets.length - deleteCount;

      if (options.dryRun) {
        env.io.write(
          `${colorize(env.io, "yellow", "dry-run")}: no files deleted (${deleteCount} to delete, ${skipCount} skipped)`
        );
        return;
      }

      const result = applyResetPlan(plan, { force: true });
      const runtime = openCliRuntime(runtimeOptions);

      try {
        runtime.services.project.initialize({
          name: runtime.context.project.name ?? runtime.context.project.id,
          repoRoot: runtime.cwd
        });
      } finally {
        runtime.close();
      }

      env.io.write(
        `${colorize(env.io, "green", "reset")}: deleted ${result.removed.length} of ${plan.targets.length} local state file(s)`
      );
      env.io.write(`${colorize(env.io, "green", "store")}: recreated ${plan.storePath}`);
    });
}

function writeResetPlan(env: CliExecutionEnvironment, plan: ResetPlan): void {
  env.io.write(planHeading(env.io, "reset plan:"));
  writeLines(
    env.io,
    planContextLines([
      ["project", `${plan.projectId} (${plan.projectName})`],
      ["repo", plan.repoRoot],
      ["data root", plan.dataRoot],
      ["store", plan.storePath]
    ])
  );

  env.io.write(planHeading(env.io, "targets:"));

  // Show what reset does to each file: present files are deleted, missing ones skipped.
  const items: PlanItem[] = plan.targets.map((target) => ({
    token: target.present ? "delete" : "skip",
    color: target.present ? "red" : "cyan",
    cells: [target.relativePath, target.description]
  }));

  writeLines(env.io, planItemLines(env.io, items, { tokenWidth: RESET_TOKEN_WIDTH }));
}
