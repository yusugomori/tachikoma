import { type Command, Option } from "commander";

import { shellCommand } from "../../adapters/index.js";
import { isTachikomaSourceCheckout } from "../../config/source-checkout.js";
import {
  applyNonBlockedInstallWrites,
  type HostHookTarget,
  type McpServerConfig,
  type PlannedWrite,
  planInstall
} from "../../services/index.js";
import { colorize, writeLines } from "../io.js";
import { type PlanItem, planHeading, planItemLines } from "../plan-format.js";
import {
  type CliExecutionEnvironment,
  openCliRuntime,
  runtimeOptionsFromCommand
} from "../runtime.js";

const BOOTSTRAP_TOKEN_WIDTH = Math.max(
  "created".length,
  "updated".length,
  "skip".length,
  "blocked".length
);

interface InitOptions {
  all?: boolean;
  dryRun?: boolean;
  force?: boolean;
  hostHooks?: boolean;
  codexTrust?: boolean;
  mcp?: boolean;
  runtime?: "codex" | "claude";
  storeOnly?: boolean;
}

type BootstrapStatus = "blocked" | "created" | "skip" | "updated";

export function registerInitCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("init")
    .description("Initialize Tachikoma state and install local agent integration.")
    .option("--dry-run", "Print the init plan without writing files or creating the store.")
    .addOption(
      new Option(
        "--runtime <runtime>",
        "Limit runtime-specific generated skills and host hooks."
      ).choices(["codex", "claude"])
    )
    .option("--all", "Install runtime-specific integration for all supported runtimes.")
    .addOption(
      new Option(
        "--store-only",
        "Only initialize the event store; do not write repository integration."
      )
    )
    .option("--force", "Allow writes to tracked Tachikoma integration files.")
    .option("--no-host-hooks", "Skip Codex and Claude host hook activation files.")
    .option(
      "--no-codex-trust",
      "Skip registering this project as trusted in the user-global Codex config.toml."
    )
    .option("--no-mcp", "Skip .mcp.json.")
    .action(async function (this: Command, options: InitOptions) {
      const runtimeOptions = runtimeOptionsFromCommand(this, env);
      const shouldBootstrap = !options.storeOnly;
      let bootstrapPlan: ReturnType<typeof planInstall> | undefined;

      if (shouldBootstrap) {
        bootstrapPlan = planInstall({
          repoRoot: runtimeOptions.cwd,
          dataRoot: runtimeOptions.dataRoot,
          projectId: runtimeOptions.projectId,
          projectName: runtimeOptions.projectName,
          force: options.force,
          dryRun: options.dryRun,
          includeDocs: false,
          includeHostHooks: options.hostHooks !== false,
          includeCodexTrust: options.codexTrust !== false,
          runtimeTargets: runtimeTargetsFromOptions(options),
          includeMcp: options.mcp,
          mcpServer: inferMcpServerConfig(runtimeOptions.cwd ?? process.cwd())
        });
      }

      if (options.dryRun) {
        const dryRunPlan =
          bootstrapPlan ??
          planInstall({
            repoRoot: runtimeOptions.cwd,
            dataRoot: runtimeOptions.dataRoot,
            projectId: runtimeOptions.projectId,
            projectName: runtimeOptions.projectName,
            force: options.force,
            dryRun: true,
            includeProjectFiles: false,
            includeGitignore: false,
            includeSkills: false,
            includeDocs: false,
            includeHostHooks: false,
            includeMcp: false,
            runtimeTargets: runtimeTargetsFromOptions(options)
          });

        env.io.write(`initialized project: ${dryRunPlan.projectConfig.project_id} (dry-run)`);
        env.io.write(`store: ${runtimeOptions.storePath ?? dryRunPlan.storePath}`);

        if (bootstrapPlan) {
          writeBootstrapSummary(env, bootstrapPlan.writes, bootstrapPlan.repoRoot);
        } else {
          env.io.write("bootstrap: skipped");
          if (options.storeOnly) {
            env.io.write("reason: --store-only leaves repository files untouched");
          }
        }

        env.io.write(`${colorize(env.io, "yellow", "dry-run")}: no files written`);
        return;
      }

      if (bootstrapPlan) {
        applyNonBlockedInstallWrites(bootstrapPlan);
      }

      const runtime = openCliRuntime(runtimeOptions);

      try {
        const event = runtime.services.project.initialize({
          name: runtime.context.project.name ?? runtime.context.project.id,
          repoRoot: runtime.cwd
        });

        env.io.write(`initialized project: ${event.projectId}`);
        env.io.write(`store: ${runtime.storePath}`);

        if (bootstrapPlan) {
          writeBootstrapSummary(env, bootstrapPlan.writes, bootstrapPlan.repoRoot);
        } else {
          env.io.write("bootstrap: skipped");
          if (options.storeOnly) {
            env.io.write("reason: --store-only leaves repository files untouched");
          }
        }
      } finally {
        runtime.close();
      }
    });
}

function runtimeTargetsFromOptions(options: InitOptions): HostHookTarget[] | undefined {
  if (options.all) {
    return ["codex", "claude"];
  }

  return options.runtime ? [options.runtime] : undefined;
}

function writeBootstrapSummary(
  env: CliExecutionEnvironment,
  writes: PlannedWrite[],
  repoRoot: string
): void {
  env.io.write(planHeading(env.io, "bootstrap:"));

  const blockedWrites = writes.filter((write) => write.blocked);
  const items: PlanItem[] = writes.map((write) => {
    const status = statusForWrite(write);

    return {
      token: status,
      color: colorForBootstrapStatus(status),
      cells: [write.relativePath, write.reason]
    };
  });

  writeLines(env.io, planItemLines(env.io, items, { tokenWidth: BOOTSTRAP_TOKEN_WIDTH }));

  if (blockedWrites.length > 0) {
    env.io.write("attention: tracked bootstrap files were not written.");
    env.io.write(
      "attention: run tachikoma init --force to write them, or inspect tachikoma install --dry-run."
    );
  }

  const mcpWrite = writes.find((write) => write.relativePath === ".mcp.json");

  if (!mcpWrite) {
    env.io.write(
      "next: MCP config skipped; run tachikoma init again without --no-mcp to enable /mcp."
    );
    return;
  }

  if (mcpWrite.blocked) {
    env.io.write("next: MCP config was blocked; inspect tachikoma install --dry-run.");
    return;
  }

  env.io.write("mcp config: ready (.mcp.json)");
  env.io.write(
    `codex mcp: if /mcp does not list tachikoma, run ${codexMcpAddHint(repoRoot)} and restart Codex.`
  );

  if (hasHostHookWrites(writes)) {
    env.io.write(
      "next: restart Claude or Codex, review/trust hooks, run /mcp, then use /tachikoma or $tachikoma."
    );
  } else {
    env.io.write("next: restart Claude or Codex, run /mcp, then use /tachikoma or $tachikoma.");
  }
}

function hasHostHookWrites(writes: PlannedWrite[]): boolean {
  return writes.some(
    (write) =>
      !write.blocked &&
      (write.relativePath === ".codex/hooks.json" ||
        write.relativePath === ".claude/settings.local.json")
  );
}

function statusForWrite(write: PlannedWrite): BootstrapStatus {
  if (write.blocked) {
    return "blocked";
  }

  if (write.action === "skip") {
    return "skip";
  }

  return write.action === "create" ? "created" : "updated";
}

function colorForBootstrapStatus(status: BootstrapStatus): "green" | "yellow" | "cyan" {
  switch (status) {
    case "blocked":
      return "yellow";
    case "created":
    case "updated":
      return "green";
    default:
      return "cyan";
  }
}

function inferMcpServerConfig(repoRoot: string): McpServerConfig {
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

function codexMcpAddHint(repoRoot: string): string {
  const server = inferMcpServerConfig(repoRoot);
  const envArgs = Object.entries(server.env ?? {}).flatMap(([key, value]) => [
    "--env",
    `${key}=${value}`
  ]);

  return shellCommand([
    "codex",
    "mcp",
    "add",
    ...envArgs,
    "tachikoma",
    "--",
    server.command,
    ...server.args
  ]);
}
