import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseToml } from "toml";
import { afterEach, describe, expect, it } from "vitest";

import { resolveCodexGlobalConfigPath } from "../../src/config/paths.js";
import {
  diagnoseInstall,
  planInstall,
  planUninstall,
  removeCodexTrustBlock,
  upsertCodexTrustBlock
} from "../../src/services/index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tachikoma-trust-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("upsertCodexTrustBlock", () => {
  const root = "/Users/dev/proj/tachikoma";

  it("appends a trust table to an empty config", () => {
    const result = upsertCodexTrustBlock("", root);
    const parsed = parseToml(result) as {
      projects: Record<string, { trust_level: string }>;
    };
    expect(parsed.projects[root]?.trust_level).toBe("trusted");
  });

  it("appends a trust table while preserving existing content and comments", () => {
    const existing = `# my codex config\nmodel = "gpt-5"\n\n[projects."/other/project"]\ntrust_level = "trusted"\n`;
    const result = upsertCodexTrustBlock(existing, root);

    expect(result).toContain("# my codex config");
    expect(result).toContain('[projects."/other/project"]');

    const parsed = parseToml(result) as {
      projects: Record<string, { trust_level: string }>;
    };
    expect(parsed.projects["/other/project"]?.trust_level).toBe("trusted");
    expect(parsed.projects[root]?.trust_level).toBe("trusted");
  });

  it("is idempotent when the project is already trusted", () => {
    const once = upsertCodexTrustBlock("", root);
    const twice = upsertCodexTrustBlock(once, root);
    expect(twice).toBe(once);
  });

  it("upgrades an existing untrusted entry in place without duplicating the table", () => {
    const existing = `[projects."${root}"]\ntrust_level = "untrusted"\n`;
    const result = upsertCodexTrustBlock(existing, root);

    const headerCount = result
      .split("\n")
      .filter((line) => line.trim() === `[projects."${root}"]`).length;
    expect(headerCount).toBe(1);

    const parsed = parseToml(result) as {
      projects: Record<string, { trust_level: string }>;
    };
    expect(parsed.projects[root]?.trust_level).toBe("trusted");
  });
});

describe("removeCodexTrustBlock", () => {
  const root = "/Users/dev/proj/tachikoma";

  it("removes only the matching project table and keeps the rest", () => {
    const existing = `model = "gpt-5"\n\n[projects."/other"]\ntrust_level = "trusted"\n\n[projects."${root}"]\ntrust_level = "trusted"\n`;
    const result = removeCodexTrustBlock(existing, root);

    expect(result).not.toContain(`[projects."${root}"]`);
    const parsed = parseToml(result) as {
      model: string;
      projects: Record<string, { trust_level: string }>;
    };
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.projects["/other"]?.trust_level).toBe("trusted");
    expect(parsed.projects[root]).toBeUndefined();
  });

  it("returns the input unchanged when the project is not present", () => {
    const existing = `[projects."/other"]\ntrust_level = "trusted"\n`;
    expect(removeCodexTrustBlock(existing, root)).toBe(existing);
  });

  it("round-trips with upsert (install then uninstall)", () => {
    const base = `model = "gpt-5"\n`;
    const installed = upsertCodexTrustBlock(base, root);
    expect(installed).toContain(`[projects."${root}"]`);
    const removed = removeCodexTrustBlock(installed, root);
    const parsed = parseToml(removed) as { model: string; projects?: Record<string, unknown> };
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.projects?.[root]).toBeUndefined();
  });
});

describe("resolveCodexGlobalConfigPath", () => {
  it("honors CODEX_HOME when set", () => {
    expect(resolveCodexGlobalConfigPath({ CODEX_HOME: "/custom/codex" })).toBe(
      "/custom/codex/config.toml"
    );
  });
});

describe("planInstall codex trust", () => {
  function initRepo(): string {
    const repoRoot = makeTempDir();
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    return repoRoot;
  }

  it("plans a trust write to the user-global codex config when host hooks are enabled", () => {
    const repoRoot = initRepo();
    const codexHome = makeTempDir();

    const plan = planInstall({
      repoRoot,
      includeProjectFiles: false,
      includeGitignore: false,
      includeSkills: false,
      includeDocs: false,
      includeMcp: false,
      includeHostHooks: true,
      runtimeTargets: ["codex"],
      env: { CODEX_HOME: codexHome }
    });

    const configPath = resolveCodexGlobalConfigPath({ CODEX_HOME: codexHome });
    const trustWrite = plan.writes.find((write) => write.path === configPath);
    expect(trustWrite).toBeDefined();
    expect(trustWrite?.action).toBe("create");
    expect(trustWrite?.blocked).toBe(false);

    const parsed = parseToml(trustWrite?.content ?? "") as {
      projects: Record<string, { trust_level: string }>;
    };
    expect(parsed.projects[repoRoot]?.trust_level).toBe("trusted");
  });

  it("skips the trust write when --no-codex-trust (includeCodexTrust false)", () => {
    const repoRoot = initRepo();
    const codexHome = makeTempDir();

    const plan = planInstall({
      repoRoot,
      includeProjectFiles: false,
      includeGitignore: false,
      includeSkills: false,
      includeDocs: false,
      includeMcp: false,
      includeHostHooks: true,
      includeCodexTrust: false,
      runtimeTargets: ["codex"],
      env: { CODEX_HOME: codexHome }
    });

    const configPath = resolveCodexGlobalConfigPath({ CODEX_HOME: codexHome });
    expect(plan.writes.find((write) => write.path === configPath)).toBeUndefined();
  });

  it("marks the trust write as skip when already trusted", () => {
    const repoRoot = initRepo();
    const codexHome = makeTempDir();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, upsertCodexTrustBlock("", repoRoot));

    const plan = planInstall({
      repoRoot,
      includeProjectFiles: false,
      includeGitignore: false,
      includeSkills: false,
      includeDocs: false,
      includeMcp: false,
      includeHostHooks: true,
      runtimeTargets: ["codex"],
      env: { CODEX_HOME: codexHome }
    });

    const trustWrite = plan.writes.find((write) => write.path === configPath);
    expect(trustWrite?.action).toBe("skip");
    expect(existsSync(configPath)).toBe(true);
  });
});

describe("diagnoseInstall codex trust", () => {
  function initRepo(): string {
    const repoRoot = makeTempDir();
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    return repoRoot;
  }

  it("reports ok when the project is trusted", () => {
    const repoRoot = initRepo();
    const codexHome = makeTempDir();
    writeFileSync(join(codexHome, "config.toml"), upsertCodexTrustBlock("", repoRoot));

    const diagnostics = diagnoseInstall({ repoRoot, env: { CODEX_HOME: codexHome } });
    expect(diagnostics.codexTrust.status).toBe("ok");
  });

  it("reports missing when no trust entry exists", () => {
    const repoRoot = initRepo();
    const codexHome = makeTempDir();

    const diagnostics = diagnoseInstall({ repoRoot, env: { CODEX_HOME: codexHome } });
    expect(diagnostics.codexTrust.status).toBe("missing");
  });
});

describe("planUninstall codex trust", () => {
  function initRepo(): string {
    const repoRoot = makeTempDir();
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    return repoRoot;
  }

  it("plans an edit that strips the trust entry while keeping other projects", () => {
    const repoRoot = initRepo();
    const codexHome = makeTempDir();
    const configPath = join(codexHome, "config.toml");
    const seeded = upsertCodexTrustBlock(
      `[projects."/other"]\ntrust_level = "trusted"\n`,
      repoRoot
    );
    writeFileSync(configPath, seeded);

    const plan = planUninstall({ repoRoot, env: { CODEX_HOME: codexHome } });
    const target = plan.targets.find((entry) => entry.kind === "codex-trust");
    expect(target?.action).toBe("edit");
    expect(target?.nextContent).not.toContain(`[projects."${repoRoot}"]`);
    expect(target?.nextContent).toContain('[projects."/other"]');
  });

  it("skips when no trust entry exists for the project", () => {
    const repoRoot = initRepo();
    const codexHome = makeTempDir();
    writeFileSync(join(codexHome, "config.toml"), `[projects."/other"]\ntrust_level = "trusted"\n`);

    const plan = planUninstall({ repoRoot, env: { CODEX_HOME: codexHome } });
    const target = plan.targets.find((entry) => entry.kind === "codex-trust");
    expect(target?.action).toBe("skip");
  });
});
