import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyUninstallPlan,
  planUninstall,
  TACHIKOMA_AGENT_DOCS_END,
  TACHIKOMA_AGENT_DOCS_START,
  TACHIKOMA_GITIGNORE_END,
  TACHIKOMA_GITIGNORE_START,
  UninstallForceRequiredError
} from "../../src/services/index.js";

const SKILL_NAMES = [
  "tachikoma",
  "tachikoma-boot",
  "tachikoma-sync",
  "tachikoma-relay",
  "tachikoma-dismiss"
];

const TACHIKOMA_HOOK_ENTRY = {
  hooks: [
    {
      type: "command",
      command: "tachikoma --cwd /x hook receive --runtime claude --format claude-json --event Stop"
    }
  ]
};

const FOREIGN_HOOK_ENTRY = {
  hooks: [{ type: "command", command: "echo foreign" }]
};

describe("uninstall-service", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function scaffold(): string {
    const root = mkdtempSync(join(tmpdir(), "tachikoma-uninstall-"));
    roots.push(root);

    // .tachikoma state/identity directory.
    mkdirSync(join(root, ".tachikoma", "state"), { recursive: true });
    writeFileSync(join(root, ".tachikoma", "project.toml"), 'project_id = "proj_x"\n');

    // Generated skill directories for both runtimes, plus one foreign skill to keep.
    for (const host of [".claude", ".codex"]) {
      for (const name of SKILL_NAMES) {
        mkdirSync(join(root, host, "skills", name), { recursive: true });
        writeFileSync(join(root, host, "skills", name, "SKILL.md"), `name: ${name}\n`);
      }
    }
    mkdirSync(join(root, ".claude", "skills", "keep"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "keep", "SKILL.md"), "name: keep\n");

    // Host hooks: Codex file is tachikoma-only; Claude file mixes foreign + permissions.
    writeFileSync(
      join(root, ".codex", "hooks.json"),
      `${JSON.stringify({ hooks: { Stop: [TACHIKOMA_HOOK_ENTRY] } }, null, 2)}\n`
    );
    writeFileSync(
      join(root, ".claude", "settings.local.json"),
      `${JSON.stringify(
        {
          permissions: { allow: ["Read"] },
          hooks: {
            SessionStart: [TACHIKOMA_HOOK_ENTRY, FOREIGN_HOOK_ENTRY],
            Stop: [TACHIKOMA_HOOK_ENTRY]
          }
        },
        null,
        2
      )}\n`
    );

    // MCP config with a foreign server alongside tachikoma.
    writeFileSync(
      join(root, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            other: { command: "foo", args: [] },
            tachikoma: { command: "tachikoma", args: ["mcp"] }
          }
        },
        null,
        2
      )}\n`
    );

    // .gitignore: user content above the managed block.
    writeFileSync(
      join(root, ".gitignore"),
      `node_modules/\ndist/\n\n${TACHIKOMA_GITIGNORE_START}\n.tachikoma/state/\n.mcp.json\n${TACHIKOMA_GITIGNORE_END}\n`
    );

    // CLAUDE.md has user content + managed block; AGENTS.md is the managed block only.
    writeFileSync(
      join(root, "CLAUDE.md"),
      `# My Project\n\nHand-written guidance.\n\n${TACHIKOMA_AGENT_DOCS_START}\n## Tachikoma\nshared.\n${TACHIKOMA_AGENT_DOCS_END}\n`
    );
    writeFileSync(
      join(root, "AGENTS.md"),
      `${TACHIKOMA_AGENT_DOCS_START}\n## Tachikoma\nshared.\n${TACHIKOMA_AGENT_DOCS_END}\n`
    );

    return root;
  }

  it("plans the right action per target", () => {
    const root = scaffold();
    const plan = planUninstall({ repoRoot: root });

    const byPath = new Map(plan.targets.map((target) => [target.relativePath, target]));

    expect(byPath.get(".tachikoma")?.action).toBe("delete");
    expect(byPath.get(join(".claude", "skills", "tachikoma"))?.action).toBe("delete");
    expect(byPath.get(join(".codex", "hooks.json"))?.action).toBe("delete"); // becomes empty
    expect(byPath.get(join(".claude", "settings.local.json"))?.action).toBe("edit"); // foreign survives
    expect(byPath.get(".mcp.json")?.action).toBe("edit"); // other server survives
    expect(byPath.get(".gitignore")?.action).toBe("edit"); // user lines survive
    expect(byPath.get("AGENTS.md")?.action).toBe("delete"); // block was whole file
    expect(byPath.get("CLAUDE.md")?.action).toBe("edit"); // user content survives
  });

  it("requires force to apply", () => {
    const root = scaffold();
    const plan = planUninstall({ repoRoot: root });

    expect(() => applyUninstallPlan(plan)).toThrow(UninstallForceRequiredError);
    // Nothing was removed.
    expect(existsSync(join(root, ".tachikoma"))).toBe(true);
  });

  it("surgically removes Tachikoma integration and preserves foreign content", () => {
    const root = scaffold();
    const plan = planUninstall({ repoRoot: root });
    const result = applyUninstallPlan(plan, { force: true });

    // State and generated skills gone.
    expect(existsSync(join(root, ".tachikoma"))).toBe(false);
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(root, ".claude", "skills", name))).toBe(false);
      expect(existsSync(join(root, ".codex", "skills", name))).toBe(false);
    }

    // Foreign skill kept, so .claude and .claude/skills are NOT pruned.
    expect(existsSync(join(root, ".claude", "skills", "keep", "SKILL.md"))).toBe(true);

    // .codex had only Tachikoma artifacts -> fully pruned.
    expect(existsSync(join(root, ".codex"))).toBe(false);
    expect(result.removedEmptyDirs).toContain(join(".codex", "skills"));
    expect(result.removedEmptyDirs).toContain(".codex");

    // Claude settings: Tachikoma hooks removed, foreign hook + permissions kept.
    const settings = JSON.parse(
      readFileSync(join(root, ".claude", "settings.local.json"), "utf8")
    ) as {
      permissions?: unknown;
      hooks?: { SessionStart?: unknown[]; Stop?: unknown[] };
    };
    expect(settings.permissions).toEqual({ allow: ["Read"] });
    expect(settings.hooks?.SessionStart).toEqual([FOREIGN_HOOK_ENTRY]);
    expect(settings.hooks?.Stop).toBeUndefined();

    // MCP: tachikoma entry gone, foreign server kept.
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(mcp.mcpServers?.tachikoma).toBeUndefined();
    expect(mcp.mcpServers?.other).toEqual({ command: "foo", args: [] });

    // .gitignore: managed block stripped, user lines kept.
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gitignore).not.toContain(TACHIKOMA_GITIGNORE_START);
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");

    // CLAUDE.md: block stripped, user content kept; AGENTS.md removed entirely.
    const claudeMd = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claudeMd).not.toContain(TACHIKOMA_AGENT_DOCS_START);
    expect(claudeMd).toContain("# My Project");
    expect(claudeMd).toContain("Hand-written guidance.");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  });
});
