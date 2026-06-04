import type { Command } from "commander";

import { writeLines } from "../io.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

export function registerMemoryCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("memory")
    .description("Print compact shared project memory.")
    .action(async function (this: Command) {
      await withCliRuntime(this, env, (runtime) => {
        writeLines(env.io, runtime.projections().brief.lines);
      });
    });
}
