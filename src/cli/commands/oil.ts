import { type Command, Option } from "commander";

import type { CliExecutionEnvironment } from "../runtime.js";
import { type ClaudeEffort, launchClaudeRuntime } from "./claude.js";
import { launchCodexRuntime } from "./codex.js";

type OilGrade = "natural" | "synthetic";

interface OilGradeOptions {
  synthetic?: boolean;
}

/**
 * `tachikoma oil` fuels a runtime by oil grade. Tachikoma loves natural oil, so
 * the default grade runs each runtime at full power; `--synthetic` is the lesser
 * grade and dials it back.
 *
 *   natural   → claude --effort max · codex xhigh + fast service tier
 *   synthetic → claude --effort low · codex default (not fast) service tier
 */
export function registerOilCommand(program: Command, env: CliExecutionEnvironment): void {
  const oil = program
    .command("oil")
    .description("Fuel a Tachikoma runtime with oil. Tachikoma loves natural oil.");

  oil
    .command("claude")
    .description("Fuel a Claude runtime (natural = --effort max, synthetic = --effort low).")
    .option("--name <name>", "Agent name. Defaults to the next available claude-NN name.")
    .option("--role <role>", "Optional project-local routing label.")
    .option("--synthetic", "Use synthetic (not natural) oil: run at lower effort.")
    .addOption(new Option("--dry-run", "Print the launch without running it.").hideHelp())
    .action(async function (this: Command) {
      const grade = oilGrade(this.opts<OilGradeOptions>());
      const effort: ClaudeEffort = grade === "natural" ? "max" : "low";

      await launchClaudeRuntime(this, env, { effort });
    });

  oil
    .command("codex")
    .description("Fuel a Codex runtime (natural = xhigh + fast, synthetic = low + not fast).")
    .option("--name <name>", "Agent name. Defaults to the next available codex-NN name.")
    .option("--role <role>", "Optional project-local routing label.")
    .option("--synthetic", "Use synthetic (not natural) oil: lower effort and drop the fast tier.")
    .option("--watch", "Run headless delivery watch without opening Codex TUI.")
    .addOption(new Option("--dry-run", "Print the launch plan without running it.").hideHelp())
    .action(async function (this: Command) {
      const grade = oilGrade(this.opts<OilGradeOptions>());
      const overrides =
        grade === "natural"
          ? { reasoningEffort: "xhigh", serviceTier: "fast" }
          : { reasoningEffort: "low", serviceTier: "default" };

      await launchCodexRuntime(this, env, overrides);
    });

  oil.action(function (this: Command) {
    env.io.write("No oil runtime specified. Use `tachikoma oil claude` or `tachikoma oil codex`.");
    this.outputHelp();
  });
}

function oilGrade(options: OilGradeOptions): OilGrade {
  return options.synthetic ? "synthetic" : "natural";
}
