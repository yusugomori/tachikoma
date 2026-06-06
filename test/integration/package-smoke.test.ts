import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

describe("package smoke", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs the publishable CLI with dist output, migrations, docs, and installer", () => {
    const packRoot = makeTempRoot(roots);
    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", packRoot], {
      encoding: "utf8"
    });
    const packed = parseNpmPackJson(output);
    const tarball = join(packRoot, packed[0]?.filename ?? "");

    expect(existsSync(tarball)).toBe(true);

    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");

    expect(entries).toContain("package/package.json");
    expect(entries).toContain("package/dist/src/cli/index.js");
    expect(entries).toContain("package/README.md");
    expect(entries).toContain("package/README.ja.md");
    expect(entries).toContain("package/install.sh");
    expect(entries.some((entry) => entry.startsWith("package/dist/src/store/migrations/"))).toBe(
      true
    );
    expect(entries).not.toContain("package/src/cli/index.ts");

    const extractRoot = makeTempRoot(roots);
    execFileSync("tar", ["-xzf", tarball, "-C", extractRoot]);

    const packageJson = JSON.parse(
      readFileSync(join(extractRoot, "package", "package.json"), "utf8")
    ) as {
      name?: string;
      bin?: Record<string, string>;
      engines?: Record<string, string>;
      files?: string[];
      private?: boolean;
    };

    expect(packageJson.name).toBe("@yusugomori/tachikoma");
    expect(packageJson.private).toBeUndefined();
    expect(packageJson.bin?.tachikoma).toBe("dist/src/cli/index.js");
    expect(packageJson.engines?.node).toBe(">=22");
    expect(packageJson.files).toContain("install.sh");
    // npm pack triggers prepack -> full tsc build, which is slow on cold CI runners.
  }, 120000);

  it("runs the built CLI and dry-runs the one-line installer", () => {
    const projectRoot = makeTempRoot(roots);

    execFileSync("pnpm", ["build"], { stdio: "pipe" });

    expect(execFileSync("node", ["dist/src/cli/index.js", "--version"], { encoding: "utf8" })).toBe(
      "0.2.0\n"
    );
    expect(
      execFileSync("node", ["dist/src/cli/index.js", "--help"], { encoding: "utf8" })
    ).toContain("Local project-state runtime for coding agents.");

    const init = execFileSync(
      "node",
      ["dist/src/cli/index.js", "--cwd", projectRoot, "init", "--dry-run"],
      { encoding: "utf8" }
    );

    expect(init).toContain("initialized project:");
    expect(init).toContain("(dry-run)");
    expect(init).toContain("dry-run: no files written");
    expect(existsSync(join(projectRoot, ".tachikoma", "state", "tachikoma.sqlite"))).toBe(false);

    const install = execFileSync("sh", ["install.sh", "--dry-run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        TACHIKOMA_PACKAGE: "@example/tachikoma-test",
        TACHIKOMA_VERSION: "canary"
      }
    });

    expect(install).toContain("Installing Tachikoma: @example/tachikoma-test@canary");
    expect(install).toContain("dry-run: npm install -g @example/tachikoma-test@canary");
    expect(install).toContain("tachikoma init");
    expect(install).toContain("tachikoma claude");
    expect(install).toContain("tachikoma codex");
    // `pnpm build` runs a full tsc compile; allow ample time on cold CI runners.
  }, 120000);
});

function makeTempRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "tachikoma-package-smoke-"));
  roots.push(root);
  return root;
}

function parseNpmPackJson(output: string): Array<{ filename: string }> {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`npm pack did not print JSON output: ${output}`);
  }

  return JSON.parse(output.slice(start, end + 1)) as Array<{ filename: string }>;
}
