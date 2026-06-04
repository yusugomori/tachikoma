import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/io.js";

interface RunResult {
  ok: boolean;
  output: string;
  errors: string;
}

describe("uninstall command", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function harness() {
    const root = mkdtempSync(join(tmpdir(), "tachikoma-uninstall-cli-"));
    roots.push(root);
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIo = {
      write: (message) => {
        if (message.length > 0) output.push(message);
      },
      error: (message) => {
        if (message.length > 0) errors.push(message);
      }
    };

    return {
      root,
      run: async (...argv: string[]): Promise<RunResult> => {
        const outStart = output.length;
        const errStart = errors.length;
        try {
          await main(argv, { cwd: root, io });
          return {
            ok: true,
            output: output.slice(outStart).join("\n"),
            errors: errors.slice(errStart).join("\n")
          };
        } catch {
          return {
            ok: false,
            output: output.slice(outStart).join("\n"),
            errors: errors.slice(errStart).join("\n")
          };
        }
      }
    };
  }

  it("requires --dry-run or --force", async () => {
    const cli = harness();
    await cli.run("init");

    const result = await cli.run("uninstall");

    expect(result.ok).toBe(false);
    expect(existsSync(join(cli.root, ".tachikoma"))).toBe(true);
  });

  it("previews the plan without removing anything on --dry-run", async () => {
    const cli = harness();
    await cli.run("init");

    const result = await cli.run("uninstall", "--dry-run");

    expect(result.ok).toBe(true);
    expect(result.output).toContain("uninstall plan:");
    expect(result.output).toContain(".tachikoma");
    expect(result.output).toContain("dry-run");
    // Footprint untouched.
    expect(existsSync(join(cli.root, ".tachikoma"))).toBe(true);
    expect(existsSync(join(cli.root, ".mcp.json"))).toBe(true);
  });

  it("removes the init footprint on --force", async () => {
    const cli = harness();
    await cli.run("init");

    expect(existsSync(join(cli.root, ".tachikoma"))).toBe(true);
    expect(existsSync(join(cli.root, ".claude", "skills", "tachikoma"))).toBe(true);
    expect(existsSync(join(cli.root, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(cli.root, ".mcp.json"))).toBe(true);

    const result = await cli.run("uninstall", "--force");

    expect(result.ok).toBe(true);
    expect(result.output).toContain("uninstall:");
    expect(existsSync(join(cli.root, ".tachikoma"))).toBe(false);
    expect(existsSync(join(cli.root, ".claude", "skills", "tachikoma"))).toBe(false);
    expect(existsSync(join(cli.root, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(cli.root, ".mcp.json"))).toBe(false);
  });
});
