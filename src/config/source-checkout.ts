import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How to invoke the tachikoma CLI for a given working directory.
 *
 * `command` plus `leadingArgs` form the prefix that precedes the actual
 * subcommand (e.g. `["--cwd", cwd, "hook", "monitor", ...]`).
 */
export interface TachikomaCliInvocation {
  command: string;
  leadingArgs: string[];
}

/**
 * Detect whether `repoRoot` is a checkout of the tachikoma sources themselves
 * (as opposed to a project that merely consumes tachikoma).
 *
 * This gates how generated commands invoke the CLI: a source checkout is driven
 * through `pnpm --dir <root> tachikoma …` so it runs against local sources,
 * while any other directory must use the globally installed `tachikoma` binary.
 */
export function isTachikomaSourceCheckout(repoRoot: string): boolean {
  const packageJsonPath = join(repoRoot, "package.json");

  if (!existsSync(packageJsonPath) || !existsSync(join(repoRoot, "src", "cli", "index.ts"))) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };

    return (
      (parsed.name === "tachikoma" || parsed.name === "@yusugomori/tachikoma") &&
      typeof parsed.scripts?.tachikoma === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Resolve how to invoke the tachikoma CLI for `cwd`.
 *
 * A source checkout runs through `pnpm --dir <cwd> tachikoma …`; any other
 * directory uses the global `tachikoma` binary on PATH, because
 * `pnpm --dir <cwd>` fails with ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND when `cwd`
 * has no package.json (the common `npm i -g` case in an arbitrary project).
 */
export function tachikomaCliInvocation(cwd: string): TachikomaCliInvocation {
  if (isTachikomaSourceCheckout(cwd)) {
    return { command: "pnpm", leadingArgs: ["--dir", cwd, "tachikoma"] };
  }

  return { command: "tachikoma", leadingArgs: [] };
}
