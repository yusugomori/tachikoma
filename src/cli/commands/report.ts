import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { Command } from "commander";

import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface ReportExportOptions {
  format?: "markdown" | "json";
}

interface HandoffExportOptions {
  summary: string;
  task?: string;
}

export function registerReportCommand(program: Command, env: CliExecutionEnvironment): void {
  const report = program.command("report").description("Generate readable Tachikoma reports.");

  report
    .command("export [path]")
    .description("Write a regenerated project-state report and record the export.")
    .option("--format <format>", "markdown or json.", "markdown")
    .action(async function (this: Command, path: string | undefined, options: ReportExportOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const rendered = runtime.services.reports.render({
          format: options.format ?? "markdown"
        });
        const reportId = runtime.context.id("report");
        const outputPath = path ?? defaultReportPath(reportId, rendered.format);
        const writtenPath = writeRuntimeFile(runtime.cwd, outputPath, rendered.content);
        const event = runtime.services.reports.export({
          id: reportId,
          path: writtenPath.relativePath,
          format: rendered.format
        });

        env.io.write(`report: ${event.target.reportId}`);
        env.io.write(`path: ${writtenPath.relativePath}`);
        env.io.write(`format: ${rendered.format}`);
      });
    });

  report
    .command("handoff [path]")
    .description("Write a regenerated handoff document and record the handoff.")
    .requiredOption("--summary <summary>", "Handoff summary.")
    .option("--task <task_id>", "Task id.")
    .action(async function (
      this: Command,
      path: string | undefined,
      options: HandoffExportOptions
    ) {
      await withCliRuntime(this, env, (runtime) => {
        const rendered = runtime.services.handoffs.render({
          taskId: options.task,
          summary: options.summary
        });
        const handoffId = runtime.context.id("handoff");
        const outputPath = path ?? join(".tachikoma", "reports", `${handoffId}.md`);
        const writtenPath = writeRuntimeFile(runtime.cwd, outputPath, rendered.content);
        const event = runtime.services.handoffs.generate({
          id: handoffId,
          taskId: options.task,
          summary: options.summary
        });

        env.io.write(`handoff: ${event.target.handoffId}`);
        env.io.write(`path: ${writtenPath.relativePath}`);
        env.io.write(`format: ${rendered.format}`);
      });
    });
}

function defaultReportPath(reportId: string, format: "markdown" | "json"): string {
  return join(".tachikoma", "reports", `${reportId}.${format === "json" ? "json" : "md"}`);
}

function writeRuntimeFile(cwd: string, path: string, content: string): { relativePath: string } {
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);

  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);

  return {
    relativePath: isAbsolute(path) ? absolutePath : relative(cwd, absolutePath)
  };
}
