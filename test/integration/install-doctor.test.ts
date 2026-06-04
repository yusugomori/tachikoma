import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/io.js";
import { readProjectConfig, resolveProjectRuntime } from "../../src/config/index.js";

describe("install and doctor commands", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates commit-safe project identity and uses a machine-local store path", async () => {
    const cli = createCliHarness(roots);

    const install = await cli.run("--data-root", cli.dataRoot, "install", "--name", "Install Test");

    expect(install.ok).toBe(true);
    expect(install.output).toContain("install plan:");
    expect(install.output).toContain("project identity [commit-safe]");
    expect(install.output).toContain("create  .gitignore");
    expect(existsSync(join(cli.root, ".tachikoma", "project.toml"))).toBe(true);
    expect(readFileSync(join(cli.root, ".gitignore"), "utf8")).toContain(
      "# tachikoma:ignore:start"
    );
    expect(existsSync(join(cli.root, ".tachikoma", "state"))).toBe(false);

    const config = readProjectConfig(cli.root);

    expect(config?.name).toBe("Install Test");
    expect(config?.project_id).toMatch(/^proj_/);

    const storePath = join(cli.dataRoot, "tachikoma.sqlite");

    expect(existsSync(storePath)).toBe(false);

    const init = await cli.run("--data-root", cli.dataRoot, "init");

    expect(init.ok).toBe(true);
    expect(init.output).toContain(`store: ${storePath}`);
    expect(existsSync(storePath)).toBe(true);
  });

  it("uses project-local .tachikoma/state as the default data root", async () => {
    const cli = createCliHarness(roots);

    const init = await cli.run("init");
    const expected = resolveProjectRuntime({
      cwd: cli.root
    });

    expect(init.ok).toBe(true);
    expect(init.output).toContain("bootstrap:");
    expect(init.output).toContain("created  .tachikoma/project.toml");
    expect(init.output).toContain("created  .gitignore");
    expect(init.output).toContain("created  .claude/skills/tachikoma/SKILL.md");
    expect(init.output).toContain("created  .claude/skills/tachikoma-boot/SKILL.md");
    expect(init.output).toContain("created  .claude/skills/tachikoma-sync/SKILL.md");
    expect(init.output).toContain("created  .claude/skills/tachikoma-relay/SKILL.md");
    expect(init.output).toContain("created  .claude/skills/tachikoma-dismiss/SKILL.md");
    expect(init.output).toContain("created  .codex/skills/tachikoma/SKILL.md");
    expect(init.output).toContain("created  .codex/skills/tachikoma-boot/SKILL.md");
    expect(init.output).toContain("created  .codex/skills/tachikoma-sync/SKILL.md");
    expect(init.output).toContain("created  .codex/skills/tachikoma-relay/SKILL.md");
    expect(init.output).toContain("created  .codex/skills/tachikoma-dismiss/SKILL.md");
    expect(init.output).toContain("created  .codex/hooks.json");
    expect(init.output).toContain("created  .claude/settings.local.json");
    expect(init.output).toContain("created  .mcp.json");
    expect(init.output).toContain("mcp config: ready (.mcp.json)");
    expect(init.output).toContain("codex mcp: if /mcp does not list tachikoma, run");
    expect(init.output).toContain(
      "next: restart Claude or Codex, review/trust hooks, run /mcp, then use /tachikoma or $tachikoma."
    );
    expect(expected.dataRoot).toBe(join(cli.root, ".tachikoma", "state"));
    expect(expected.storePath).toBe(join(cli.root, ".tachikoma", "state", "tachikoma.sqlite"));
    expect(init.output).toContain(`store: ${expected.storePath}`);
    expect(existsSync(expected.storePath)).toBe(true);

    const gitignore = readFileSync(join(cli.root, ".gitignore"), "utf8");

    expect(gitignore).toContain("# tachikoma:ignore:start");
    expect(gitignore).toContain(".tachikoma/state/");
    expect(gitignore).toContain(".mcp.json");
    expect(gitignore).toContain(".codex/hooks.json");
    expect(gitignore).toContain(".claude/settings.local.json");
    expect(gitignore).toContain(".codex/skills/tachikoma-relay/");
    expect(gitignore).toContain(".claude/skills/tachikoma-dismiss/");
    expect(gitignore).toContain(".codex/skills/tachikoma-dismiss/");
    expect(gitignore).toContain("# tachikoma:ignore:end");

    const mcpConfig = JSON.parse(readFileSync(join(cli.root, ".mcp.json"), "utf8")) as {
      mcpServers?: {
        tachikoma?: {
          command?: string;
          args?: string[];
          env?: Record<string, string>;
        };
      };
    };

    expect(mcpConfig.mcpServers?.tachikoma).toMatchObject({
      command: "tachikoma",
      args: ["mcp"],
      env: {
        TACHIKOMA_CWD: cli.root
      }
    });

    const claudeSkill = readFileSync(
      join(cli.root, ".claude", "skills", "tachikoma", "SKILL.md"),
      "utf8"
    );
    const codexSkill = readFileSync(
      join(cli.root, ".codex", "skills", "tachikoma", "SKILL.md"),
      "utf8"
    );
    const claudeBootSkill = readFileSync(
      join(cli.root, ".claude", "skills", "tachikoma-boot", "SKILL.md"),
      "utf8"
    );
    const codexBootSkill = readFileSync(
      join(cli.root, ".codex", "skills", "tachikoma-boot", "SKILL.md"),
      "utf8"
    );
    const claudeSyncSkill = readFileSync(
      join(cli.root, ".claude", "skills", "tachikoma-sync", "SKILL.md"),
      "utf8"
    );
    const codexSyncSkill = readFileSync(
      join(cli.root, ".codex", "skills", "tachikoma-sync", "SKILL.md"),
      "utf8"
    );
    const claudeRelaySkill = readFileSync(
      join(cli.root, ".claude", "skills", "tachikoma-relay", "SKILL.md"),
      "utf8"
    );
    const codexRelaySkill = readFileSync(
      join(cli.root, ".codex", "skills", "tachikoma-relay", "SKILL.md"),
      "utf8"
    );
    const claudeDismissSkill = readFileSync(
      join(cli.root, ".claude", "skills", "tachikoma-dismiss", "SKILL.md"),
      "utf8"
    );
    const codexDismissSkill = readFileSync(
      join(cli.root, ".codex", "skills", "tachikoma-dismiss", "SKILL.md"),
      "utf8"
    );
    const generatedSkills = [
      claudeSkill,
      codexSkill,
      claudeBootSkill,
      codexBootSkill,
      claudeSyncSkill,
      codexSyncSkill,
      claudeRelaySkill,
      codexRelaySkill,
      claudeDismissSkill,
      codexDismissSkill
    ];

    expect(claudeSkill).toContain("name: tachikoma");
    expect(claudeSkill).toContain("Coordinate Tachikoma agent work");
    expect(claudeSkill).toContain("tachikoma_ask");
    expect(claudeSkill).toContain("tachikoma_reply");
    expect(claudeSkill).toContain("send work or questions to a named agent");
    expect(claudeSkill).toContain("normal chat answer alone does not satisfy");
    expect(claudeSkill).toContain("hook-delivered directives");
    expect(claudeSkill).toContain(
      "Tachikoma launcher identity is not visible in this skill context"
    );
    expect(claudeSkill).toContain("recorded as system");
    expect(claudeSkill).toContain("report that diagnostic instead of replacing it");
    expect(claudeSkill).toContain("actorName");
    expect(claudeSkill).toContain("actorRuntime");
    expect(claudeSkill).toContain("actorSession");
    expect(claudeSkill).toContain("Reply identity: --as <name>");
    expect(claudeSkill).not.toContain("name=musashi");
    expect(claudeSkill).not.toContain("TACHIKOMA_AGENT_NAME:-musashi");
    expect(claudeSkill).toContain('deliveryMode: "both"');
    expect(claudeSkill).toContain("hook monitor --name <name> --watch");
    expect(claudeSkill).toContain("Launcher environment Monitor input");
    expect(claudeSkill).toContain('sh -lc \\"$TACHIKOMA_MONITOR_COMMAND\\"');
    expect(claudeSkill).toContain("do not let it become a background Bash task");
    expect(claudeSkill).toContain("If the Claude Monitor tool is unavailable");
    expect(codexSkill).toContain("name: tachikoma");
    expect(codexSkill).toContain("Coordinate Tachikoma agent work");
    expect(codexSkill).toContain("tachikoma_ask");
    expect(codexSkill).toContain("tachikoma_reply");
    expect(codexSkill).toContain("send work or questions to a named agent");
    expect(codexSkill).toContain("normal chat answer alone does not satisfy");
    expect(codexSkill).toContain("hook-delivered directives");
    expect(codexSkill).toContain(
      "Tachikoma launcher identity is not visible in this skill context"
    );
    expect(codexSkill).toContain("run $tachikoma-boot <name>");
    expect(codexSkill).toContain("recorded as system");
    expect(codexSkill).toContain("report that diagnostic instead of replacing it");
    expect(codexSkill).toContain(
      "do not treat the first positional argument as this session's identity"
    );
    expect(codexSkill).toContain("live codex candidates");
    expect(codexSkill).not.toContain("Restart with tachikoma codex");
    expect(codexSkill).toContain("actorName");
    expect(codexSkill).toContain("actorRuntime");
    expect(codexSkill).toContain("actorSession");
    expect(codexSkill).toContain("Reply identity: --as <name>");
    expect(codexSkill).not.toContain("name=loki");
    expect(codexSkill).not.toContain("TACHIKOMA_AGENT_NAME:-loki");
    expect(codexSkill).not.toContain("hook monitor --name");
    expect(codexSkill).not.toContain("Claude Monitor Activation");
    expect(claudeBootSkill).toContain("name: tachikoma-boot");
    expect(claudeBootSkill).toContain("start realtime Monitor delivery");
    expect(claudeBootSkill).not.toContain("naming the agent and claiming pending inbox work");
    expect(claudeBootSkill).toContain("Boot Workflow");
    expect(claudeBootSkill).toContain("TACHIKOMA_MONITOR_COMMAND");
    expect(claudeBootSkill).toContain("do not run shell commands to inspect `TACHIKOMA_*`");
    expect(claudeBootSkill).toContain("before any status, inbox, MCP, or diagnostic checks");
    expect(claudeBootSkill).toContain("trust that launcher identity as already joined");
    expect(claudeBootSkill).toContain("hook-delivered context");
    expect(claudeBootSkill).toContain(
      "Tachikoma launcher identity is not visible in this skill context"
    );
    expect(claudeBootSkill).toContain("recorded as system");
    expect(claudeBootSkill).toContain("report that diagnostic instead of replacing it");
    expect(claudeBootSkill).toContain("Reply identity: --as <name>");
    expect(claudeBootSkill).not.toContain("name=musashi");
    expect(claudeBootSkill).not.toContain("TACHIKOMA_AGENT_NAME:-musashi");
    expect(claudeBootSkill).toContain("hook monitor --name <name> --watch");
    expect(claudeBootSkill).toContain("Launcher environment Monitor input");
    expect(claudeBootSkill).toContain("If hook-delivered context includes an exact Monitor input");
    expect(claudeBootSkill).toContain("Manual Monitor input shape");
    expect(claudeBootSkill).toContain('"timeout_ms": 1000');
    expect(claudeBootSkill).toContain("After Monitor starts, stop booting.");
    expect(codexBootSkill).toContain("name: tachikoma-boot");
    expect(codexBootSkill).toContain("Manual Tachikoma boot helper");
    expect(codexBootSkill).toContain("join only with an explicit name");
    expect(codexBootSkill).toContain("It is not required for realtime receiving");
    expect(codexBootSkill).not.toContain("naming the agent and claiming pending inbox work");
    expect(codexBootSkill).toContain("Boot Workflow");
    expect(codexBootSkill).toContain("do not run shell commands to inspect `TACHIKOMA_*`");
    expect(codexBootSkill).toContain("trust that launcher identity as already joined");
    expect(codexBootSkill).toContain(
      "Tachikoma launcher identity is not visible in this skill context"
    );
    expect(codexBootSkill).toContain("run $tachikoma-boot <name>");
    expect(codexBootSkill).toContain("recorded as system");
    expect(codexBootSkill).toContain("report that diagnostic instead of replacing it");
    expect(codexBootSkill).not.toContain("Restart with tachikoma codex");
    expect(codexBootSkill).toContain("Reply identity: --as <name>");
    expect(codexBootSkill).toContain("Codex app-server delivery loop");
    expect(codexBootSkill).toContain("$tachikoma-boot` is not required for TUI realtime delivery");
    expect(codexBootSkill).not.toContain("name=loki");
    expect(codexBootSkill).not.toContain("TACHIKOMA_AGENT_NAME:-loki");
    expect(codexBootSkill).not.toContain("hook monitor --name");
    expect(codexBootSkill).toContain("Stop after booting.");
    expect(claudeSyncSkill).toContain("name: tachikoma-sync");
    expect(claudeSyncSkill).toContain("Sync Workflow");
    expect(claudeSyncSkill).toContain("do not perform implementation work");
    expect(claudeSyncSkill).toContain("Use the primary `tachikoma` skill for messaging");
    expect(codexSyncSkill).toContain("name: tachikoma-sync");
    expect(codexSyncSkill).toContain("tachikoma_status");
    expect(codexSyncSkill).toContain("tachikoma_inbox");
    expect(codexSyncSkill).toContain("narrow send/reply-only shortcut");
    expect(claudeRelaySkill).toContain("name: tachikoma-relay");
    expect(claudeRelaySkill).toContain("Optional Tachikoma send/reply shortcut");
    expect(claudeRelaySkill).toContain("The main /tachikoma skill can also send and reply");
    expect(claudeRelaySkill).toContain("Relay Workflow");
    expect(claudeRelaySkill).toContain("tachikoma_ask");
    expect(claudeRelaySkill).toContain("tachikoma_reply");
    expect(codexRelaySkill).toContain("name: tachikoma-relay");
    expect(codexRelaySkill).toContain("Optional Tachikoma send/reply shortcut");
    expect(codexRelaySkill).toContain("The main $tachikoma skill can also send and reply");
    expect(codexRelaySkill).toContain("narrow send/reply-only action");
    expect(codexRelaySkill).not.toContain("This skill only relays messages.");

    for (const dismissSkill of [claudeDismissSkill, codexDismissSkill]) {
      expect(dismissSkill).toContain("name: tachikoma-dismiss");
      // no automatic boot/sync/relay cleanup
      expect(dismissSkill).toContain(
        "Do not run this skill automatically during boot, monitor delivery, sync, relay"
      );
      // dry-run preview by default
      expect(dismissSkill).toContain("dry-run preview for this agent only");
      // self-only default
      expect(dismissSkill).toContain("By default dismiss only this agent's own direct items");
      // no MCP dismiss tool
      expect(dismissSkill).toContain("no dismiss MCP tool");
      // no fallback sample names
      expect(dismissSkill).toContain("Do not join under a fallback sample name");
      expect(dismissSkill).not.toContain("musashi");
      expect(dismissSkill).not.toContain("loki");
      // unified placeholder
      expect(dismissSkill).toContain("inbox dismiss --as <agent_name>");
    }
    expect(claudeDismissSkill).toContain("/tachikoma-dismiss");
    expect(codexDismissSkill).toContain("$tachikoma-dismiss");

    for (const skill of generatedSkills) {
      expect(skill).toMatch(/^description: ".+"$/m);
    }
  });

  it("uses explicit --store for state while still installing repository integration", async () => {
    const cli = createCliHarness(roots);
    const storePath = join(cli.root, "state", "custom.sqlite");

    const init = await cli.run("--store", storePath, "init");

    expect(init.ok).toBe(true);
    expect(init.output).toContain(`store: ${storePath}`);
    expect(init.output).toContain("bootstrap:");
    expect(init.output).toContain("created  .tachikoma/project.toml");
    expect(init.output).not.toContain("bootstrap: skipped");
    expect(existsSync(storePath)).toBe(true);
    expect(existsSync(join(cli.root, ".tachikoma", "project.toml"))).toBe(true);
    expect(existsSync(join(cli.root, ".mcp.json"))).toBe(true);
    expect(existsSync(join(cli.root, ".tachikoma", "state", "tachikoma.sqlite"))).toBe(false);
  });

  it("prints init --dry-run without writing bootstrap files or creating the store", async () => {
    const cli = createCliHarness(roots);
    const expected = resolveProjectRuntime({
      cwd: cli.root
    });

    const init = await cli.run("init", "--dry-run");

    expect(init.ok).toBe(true);
    expect(init.output).toContain("initialized project:");
    expect(init.output).toContain("(dry-run)");
    expect(init.output).toContain("bootstrap:");
    expect(init.output).toContain("created  .tachikoma/project.toml");
    expect(init.output).toContain("created  .claude/skills/tachikoma/SKILL.md");
    expect(init.output).toContain("created  .codex/skills/tachikoma/SKILL.md");
    expect(init.output).toContain("dry-run: no files written");
    expect(existsSync(expected.storePath)).toBe(false);
    expect(existsSync(join(cli.root, ".tachikoma", "project.toml"))).toBe(false);
    expect(existsSync(join(cli.root, ".claude", "skills", "tachikoma", "SKILL.md"))).toBe(false);
    expect(existsSync(join(cli.root, ".codex", "skills", "tachikoma", "SKILL.md"))).toBe(false);
  });

  it("updates tracked .gitignore without --force and de-duplicates managed entries", async () => {
    const cli = createCliHarness(roots);
    const gitignorePath = join(cli.root, ".gitignore");

    writeFileSync(gitignorePath, ["node_modules/", "", ".tachikoma/state/", ""].join("\n"));
    execFileSync("git", ["init"], { cwd: cli.root, stdio: "ignore" });
    execFileSync("git", ["add", ".gitignore"], { cwd: cli.root, stdio: "ignore" });

    const init = await cli.run("init");
    const gitignore = readFileSync(gitignorePath, "utf8");

    expect(init.ok).toBe(true);
    expect(init.output).toContain("updated  .gitignore");
    expect(init.output).not.toContain("blocked  .gitignore");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("# tachikoma:ignore:start");
    expect(gitignore).toContain(".claude/skills/tachikoma-sync/");
    expect(gitignore.match(/\.tachikoma\/state\//g) ?? []).toHaveLength(1);
  });

  it("allows init --no-host-hooks for store and MCP setup without host activation", async () => {
    const cli = createCliHarness(roots);

    const init = await cli.run("init", "--no-host-hooks");

    expect(init.ok).toBe(true);
    expect(init.output).not.toContain(".codex/hooks.json");
    expect(init.output).not.toContain(".claude/settings.local.json");
    expect(existsSync(join(cli.root, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(cli.root, ".claude", "settings.local.json"))).toBe(false);
    expect(existsSync(join(cli.root, ".mcp.json"))).toBe(true);
  });

  it("supports init --store-only without repository integration files", async () => {
    const cli = createCliHarness(roots);

    const init = await cli.run("init", "--store-only");

    expect(init.ok).toBe(true);
    expect(init.output).toContain("bootstrap: skipped");
    expect(init.output).toContain("reason: --store-only leaves repository files untouched");
    expect(existsSync(join(cli.root, ".tachikoma", "state", "tachikoma.sqlite"))).toBe(true);
    expect(existsSync(join(cli.root, ".tachikoma", "project.toml"))).toBe(false);
    expect(existsSync(join(cli.root, ".mcp.json"))).toBe(false);
    expect(existsSync(join(cli.root, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(cli.root, ".claude", "settings.local.json"))).toBe(false);
  });

  it("resolves nested cwd to the parent Tachikoma project root", async () => {
    const cli = createCliHarness(roots);
    const nested = join(cli.root, "packages", "worker");

    await cli.run("init");
    mkdirSync(nested, { recursive: true });

    const rootRuntime = resolveProjectRuntime({ cwd: cli.root });
    const nestedRuntime = resolveProjectRuntime({ cwd: nested });

    expect(nestedRuntime.cwd).toBe(cli.root);
    expect(nestedRuntime.projectId).toBe(rootRuntime.projectId);
    expect(nestedRuntime.storePath).toBe(rootRuntime.storePath);
  });

  it("bootstraps repository files at the parent project root from nested cwd", async () => {
    const cli = createCliHarness(roots);
    const nested = join(cli.root, "packages", "worker");

    execFileSync("git", ["init"], { cwd: cli.root, stdio: "ignore" });
    mkdirSync(nested, { recursive: true });

    const init = await cli.runFrom(nested, "init");

    expect(init.ok).toBe(true);
    expect(init.output).toContain("created  .tachikoma/project.toml");
    expect(existsSync(join(cli.root, ".tachikoma", "project.toml"))).toBe(true);
    expect(existsSync(join(nested, ".tachikoma", "project.toml"))).toBe(false);
    expect(existsSync(join(cli.root, ".claude", "skills", "tachikoma", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cli.root, ".claude", "skills", "tachikoma-boot", "SKILL.md"))).toBe(
      true
    );
    expect(existsSync(join(cli.root, ".claude", "skills", "tachikoma-sync", "SKILL.md"))).toBe(
      true
    );
    expect(existsSync(join(cli.root, ".claude", "skills", "tachikoma-relay", "SKILL.md"))).toBe(
      true
    );
    expect(existsSync(join(cli.root, ".claude", "skills", "tachikoma-dismiss", "SKILL.md"))).toBe(
      true
    );
    expect(existsSync(join(cli.root, ".codex", "skills", "tachikoma", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cli.root, ".codex", "skills", "tachikoma-boot", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cli.root, ".codex", "skills", "tachikoma-sync", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cli.root, ".codex", "skills", "tachikoma-relay", "SKILL.md"))).toBe(
      true
    );
    expect(existsSync(join(cli.root, ".codex", "skills", "tachikoma-dismiss", "SKILL.md"))).toBe(
      true
    );
  });

  it("bootstraps a target repository through global --cwd", async () => {
    const cli = createCliHarness(roots);
    const target = mkdtempSync(join(tmpdir(), "tachikoma-target-"));
    roots.push(target);

    const init = await cli.run("--cwd", target, "init");

    expect(init.ok).toBe(true);
    expect(init.output).toContain(
      `store: ${join(target, ".tachikoma", "state", "tachikoma.sqlite")}`
    );
    expect(existsSync(join(target, ".tachikoma", "project.toml"))).toBe(true);
    expect(existsSync(join(target, ".claude", "skills", "tachikoma", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".claude", "skills", "tachikoma-boot", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".claude", "skills", "tachikoma-sync", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".claude", "skills", "tachikoma-relay", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".claude", "skills", "tachikoma-dismiss", "SKILL.md"))).toBe(
      true
    );
    expect(existsSync(join(target, ".codex", "skills", "tachikoma", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".codex", "skills", "tachikoma-boot", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".codex", "skills", "tachikoma-sync", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".codex", "skills", "tachikoma-relay", "SKILL.md"))).toBe(true);
    expect(existsSync(join(target, ".codex", "skills", "tachikoma-dismiss", "SKILL.md"))).toBe(
      true
    );
    expect(existsSync(join(cli.root, ".tachikoma", "project.toml"))).toBe(false);
  });

  it("shows global --cwd in help", async () => {
    const cli = createCliHarness(roots);

    const help = await cli.run("--help");

    expect(help.ok).toBe(true);
    expect(help.output).toContain("--cwd <path>");
  });

  it("keeps init and install help focused on the common workflow", async () => {
    const cli = createCliHarness(roots);

    const initHelp = await cli.run("init", "--help");
    const installHelp = await cli.run("install", "--help");

    expect(initHelp.ok).toBe(true);
    expect(initHelp.output).toContain("--dry-run");
    expect(initHelp.output).toContain("--runtime <runtime>");
    expect(initHelp.output).toContain("--all");
    expect(initHelp.output).toContain("--store-only");
    expect(initHelp.output).toContain("--no-host-hooks");

    expect(installHelp.ok).toBe(true);
    expect(installHelp.output).toContain("--dry-run");
    expect(installHelp.output).toContain("--skills");
    expect(installHelp.output).toContain("--runtime <runtime>");
    expect(installHelp.output).toContain("--all");
    expect(installHelp.output).toContain("--no-host-hooks");
  });

  it("uses the enclosing git root before Tachikoma config exists", () => {
    const cli = createCliHarness(roots);
    const nested = join(cli.root, "packages", "worker");

    execFileSync("git", ["init"], { cwd: cli.root, stdio: "ignore" });
    mkdirSync(nested, { recursive: true });

    const runtime = resolveProjectRuntime({ cwd: nested });

    expect(runtime.cwd).toBe(cli.root);
    expect(runtime.dataRoot).toBe(join(cli.root, ".tachikoma", "state"));
    expect(runtime.storePath).toBe(join(cli.root, ".tachikoma", "state", "tachikoma.sqlite"));
  });

  it("writes source-checkout MCP config through the pnpm tachikoma script", async () => {
    const cli = createCliHarness(roots);

    mkdirSync(join(cli.root, "src", "cli"), { recursive: true });
    writeFileSync(
      join(cli.root, "package.json"),
      JSON.stringify({
        name: "tachikoma",
        scripts: {
          tachikoma: "tsx src/cli/index.ts"
        }
      })
    );
    writeFileSync(join(cli.root, "src", "cli", "index.ts"), "");

    const init = await cli.run("init");

    expect(init.ok).toBe(true);
    expect(init.output).toContain(
      `codex mcp add --env TACHIKOMA_CWD=${cli.root} tachikoma -- pnpm --dir ${cli.root} tachikoma mcp`
    );

    const mcpConfig = JSON.parse(readFileSync(join(cli.root, ".mcp.json"), "utf8")) as {
      mcpServers?: {
        tachikoma?: {
          command?: string;
          args?: string[];
          env?: Record<string, string>;
        };
      };
    };

    expect(mcpConfig.mcpServers?.tachikoma).toMatchObject({
      command: "pnpm",
      args: ["--dir", cli.root, "tachikoma", "mcp"],
      env: {
        TACHIKOMA_CWD: cli.root
      }
    });

    const agentInstructions = readFileSync(
      join(cli.root, ".tachikoma", "agent-instructions.md"),
      "utf8"
    );
    const codexSkill = readFileSync(
      join(cli.root, ".codex", "skills", "tachikoma", "SKILL.md"),
      "utf8"
    );
    const codexHooks = readFileSync(join(cli.root, ".codex", "hooks.json"), "utf8");

    expect(agentInstructions).toContain("pnpm tachikoma memory");
    expect(agentInstructions).not.toContain(["memory", "--role"].join(" "));
    expect(codexSkill).not.toContain("TACHIKOMA_AGENT_NAME:-loki");
    expect(codexSkill).toContain(
      `pnpm --dir ${cli.root} tachikoma --cwd ${cli.root} join <name> --runtime codex --role "<role>" --delivery-mode turn`
    );
    expect(codexSkill).not.toContain("codex --name <name>");
    expect(codexHooks).toContain(
      `pnpm --dir ${cli.root} exec node --import tsx ${join(cli.root, "src", "cli", "index.ts")} --cwd ${cli.root} hook receive`
    );
    expect(codexHooks).not.toContain(`pnpm --dir ${cli.root} tachikoma --cwd ${cli.root} hook`);
  });

  it("updates only selected runtime skills with install --skills --runtime", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    const projectConfigPath = join(cli.root, ".tachikoma", "project.toml");
    const agentInstructionsPath = join(cli.root, ".tachikoma", "agent-instructions.md");
    const codexSkillPath = join(cli.root, ".codex", "skills", "tachikoma", "SKILL.md");
    const claudeSkillPath = join(cli.root, ".claude", "skills", "tachikoma", "SKILL.md");
    const projectConfigBefore = readFileSync(projectConfigPath, "utf8");
    const agentInstructionsBefore = readFileSync(agentInstructionsPath, "utf8");

    writeFileSync(codexSkillPath, "stale codex skill\n");
    writeFileSync(claudeSkillPath, "stale claude skill\n");

    const install = await cli.run("install", "--skills", "--runtime", "codex");

    expect(install.ok).toBe(true);
    expect(install.output).not.toContain(".tachikoma/project.toml");
    expect(install.output).not.toContain(".tachikoma/agent-instructions.md");
    expect(install.output).not.toContain(".gitignore");
    expect(install.output).not.toContain(".mcp.json");
    expect(install.output).not.toContain(".claude/skills");
    expect(install.output).toContain("update  .codex/skills/tachikoma/SKILL.md");
    expect(readFileSync(projectConfigPath, "utf8")).toBe(projectConfigBefore);
    expect(readFileSync(agentInstructionsPath, "utf8")).toBe(agentInstructionsBefore);
    expect(readFileSync(codexSkillPath, "utf8")).toContain("Quiet Mode");
    expect(readFileSync(claudeSkillPath, "utf8")).toBe("stale claude skill\n");
  });

  it("limits runtime-specific install writes with --runtime", async () => {
    const cli = createCliHarness(roots);

    const install = await cli.run("install", "--runtime", "codex", "--dry-run");

    expect(install.ok).toBe(true);
    expect(install.output).toContain(".codex/skills/tachikoma/SKILL.md");
    expect(install.output).toContain(".codex/hooks.json");
    expect(install.output).not.toContain(".claude/skills/tachikoma/SKILL.md");
    expect(install.output).not.toContain(".claude/settings.local.json");
    expect(install.output).toContain("dry-run: no files written");
  });

  it("plans real host hook activation files by default on dry-run", async () => {
    const cli = createCliHarness(roots);

    const install = await cli.run(
      "--data-root",
      cli.dataRoot,
      "install",
      "--name",
      "Host Hook Test",
      "--dry-run"
    );

    expect(install.ok).toBe(true);
    expect(install.output).toContain(".codex/hooks.json");
    expect(install.output).toContain(".claude/settings.local.json");
    expect(install.output).toContain("Codex host hook activation");
    expect(install.output).toContain("Claude host hook activation");
    expect(install.output).toContain("dry-run: no files written");
    expect(existsSync(join(cli.root, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(cli.root, ".claude", "settings.local.json"))).toBe(false);
  });

  it("allows install --no-host-hooks to skip host activation files", async () => {
    const cli = createCliHarness(roots);

    const install = await cli.run(
      "--data-root",
      cli.dataRoot,
      "install",
      "--name",
      "No Host Hooks",
      "--no-host-hooks",
      "--dry-run"
    );

    expect(install.ok).toBe(true);
    expect(install.output).not.toContain(".codex/hooks.json");
    expect(install.output).not.toContain(".claude/settings.local.json");
    expect(install.output).toContain("dry-run: no files written");
  });

  it("refuses tracked host hook activation files without force", async () => {
    const cli = createCliHarness(roots);
    const codexHooksPath = join(cli.root, ".codex", "hooks.json");
    const claudeSettingsPath = join(cli.root, ".claude", "settings.local.json");

    mkdirSync(join(cli.root, ".codex"), { recursive: true });
    mkdirSync(join(cli.root, ".claude"), { recursive: true });
    writeFileSync(codexHooksPath, "{}\n");
    writeFileSync(claudeSettingsPath, "{}\n");
    execFileSync("git", ["init"], { cwd: cli.root, stdio: "ignore" });
    execFileSync("git", ["add", "-f", ".codex/hooks.json", ".claude/settings.local.json"], {
      cwd: cli.root,
      stdio: "ignore"
    });

    const install = await cli.run(
      "--data-root",
      cli.dataRoot,
      "install",
      "--name",
      "Tracked Host Hooks"
    );

    expect(install.ok).toBe(false);
    expect(install.output).toContain("install plan:");
    expect(install.errors).toContain("blocked tracked config writes:");
    expect(install.errors).toContain(".codex/hooks.json");
    expect(install.errors).toContain(".claude/settings.local.json");
    expect(readFileSync(codexHooksPath, "utf8")).toBe("{}\n");
    expect(readFileSync(claudeSettingsPath, "utf8")).toBe("{}\n");
  });

  it("merges host hooks while preserving unrelated existing hooks", async () => {
    const cli = createCliHarness(roots);
    const codexHooksPath = join(cli.root, ".codex", "hooks.json");
    const claudeSettingsPath = join(cli.root, ".claude", "settings.local.json");

    mkdirSync(join(cli.root, ".codex"), { recursive: true });
    mkdirSync(join(cli.root, ".claude"), { recursive: true });
    writeFileSync(
      codexHooksPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo keep-codex"
                }
              ]
            }
          ]
        }
      })
    );
    writeFileSync(
      claudeSettingsPath,
      JSON.stringify({
        permissions: {
          allow: ["Read"]
        },
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo keep-claude"
                }
              ]
            }
          ]
        }
      })
    );

    const install = await cli.run("install", "--name", "Merge Host Hooks");

    expect(install.ok).toBe(true);

    const codexHooks = JSON.parse(readFileSync(codexHooksPath, "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    const claudeSettings = JSON.parse(readFileSync(claudeSettingsPath, "utf8")) as {
      permissions?: { allow?: string[] };
      hooks?: Record<string, unknown>;
    };

    expect(JSON.stringify(codexHooks.hooks?.Stop)).toContain("echo keep-codex");
    expect(JSON.stringify(codexHooks.hooks?.Stop)).toContain("hook receive");
    expect(JSON.stringify(codexHooks.hooks?.PostToolUse)).toContain("hook sent");
    expect(claudeSettings.permissions?.allow).toEqual(["Read"]);
    expect(JSON.stringify(claudeSettings.hooks?.PostToolUse)).toContain("echo keep-claude");
    expect(JSON.stringify(claudeSettings.hooks?.PostToolUse)).toContain("hook sent");
    expect(JSON.stringify(claudeSettings.hooks?.Stop)).toContain("hook receive");

    const doctor = await cli.run("doctor");

    expect(doctor.output).toContain("codex hooks: ok");
    expect(doctor.output).toContain("claude hooks: ok");
    expect(doctor.output).toContain(
      "codex skill: ok Codex tachikoma skill is a coordination entrypoint"
    );
    expect(doctor.output).toContain(
      "claude skill: ok Claude tachikoma skill is a coordination entrypoint"
    );
    expect(doctor.output).toContain(
      "claude monitor: ok Claude monitor startup instructions and host hooks configured"
    );
    expect(doctor.output).toContain("claude monitor troubleshooting:");
    expect(doctor.output).toContain("no active session");
    expect(doctor.output).toContain("delivery mode turn/off");
  });

  it("keeps MCP ready when tracked bootstrap files are blocked", async () => {
    const cli = createCliHarness(roots);
    const tachikomaDir = join(cli.root, ".tachikoma");
    const projectConfigPath = join(tachikomaDir, "project.toml");
    const instructionsPath = join(tachikomaDir, "agent-instructions.md");

    mkdirSync(tachikomaDir, { recursive: true });
    writeFileSync(projectConfigPath, 'project_id = "old"\nname = "Old"\nschema_version = 1\n');
    writeFileSync(instructionsPath, "# Existing instructions\n");
    execFileSync("git", ["init"], { cwd: cli.root, stdio: "ignore" });
    execFileSync("git", ["add", ".tachikoma/project.toml", ".tachikoma/agent-instructions.md"], {
      cwd: cli.root,
      stdio: "ignore"
    });
    rmSync(projectConfigPath);
    rmSync(instructionsPath);

    const init = await cli.run("init");

    expect(init.ok).toBe(true);
    expect(init.output).toContain("blocked  .tachikoma/project.toml");
    expect(init.output).toContain("blocked  .tachikoma/agent-instructions.md");
    expect(init.output).toContain("attention: tracked bootstrap files were not written.");
    expect(init.output).toContain("tachikoma init --force");
    expect(init.output).toContain("created  .mcp.json");
    expect(init.output).toContain("mcp config: ready (.mcp.json)");
    expect(init.output).toContain("codex mcp: if /mcp does not list tachikoma, run");
    expect(init.output).toContain(
      "next: restart Claude or Codex, review/trust hooks, run /mcp, then use /tachikoma or $tachikoma."
    );
    expect(existsSync(join(cli.root, ".mcp.json"))).toBe(true);
  });

  it("allows init --force to write tracked bootstrap files", async () => {
    const cli = createCliHarness(roots);
    const tachikomaDir = join(cli.root, ".tachikoma");
    const projectConfigPath = join(tachikomaDir, "project.toml");
    const instructionsPath = join(tachikomaDir, "agent-instructions.md");

    mkdirSync(tachikomaDir, { recursive: true });
    writeFileSync(projectConfigPath, 'project_id = "old"\nname = "Old"\nschema_version = 1\n');
    writeFileSync(instructionsPath, "# Existing instructions\n");
    execFileSync("git", ["init"], { cwd: cli.root, stdio: "ignore" });
    execFileSync("git", ["add", ".tachikoma/project.toml", ".tachikoma/agent-instructions.md"], {
      cwd: cli.root,
      stdio: "ignore"
    });

    const init = await cli.run("init", "--force");

    expect(init.ok).toBe(true);
    expect(init.output).toContain("updated  .tachikoma/project.toml");
    expect(init.output).toContain("updated  .tachikoma/agent-instructions.md");
    expect(init.output).not.toContain("blocked  .tachikoma/project.toml");
    expect(readFileSync(projectConfigPath, "utf8")).toContain("# Tachikoma project identity.");
    expect(readFileSync(projectConfigPath, "utf8")).toContain('project_id = "old"');
    expect(readFileSync(instructionsPath, "utf8")).toContain("Tachikoma Agent Instructions");
  });

  it("renders skip for unchanged bootstrap files and colors only the status token", async () => {
    const cli = createCliHarness(roots, { colors: true });

    await cli.run("init");

    const init = await cli.run("init");

    expect(init.ok).toBe(true);
    expect(init.output).toContain("bootstrap:");
    expect(init.output).toContain("\u001b[1mbootstrap:\u001b[0m");
    expect(init.output).toContain("\u001b[36mskip\u001b[0m");
    expect(init.output).not.toContain("\u001b[36m  skip");
    expect(init.output).toContain("mcp config: ready (.mcp.json)");
    expect(init.output).not.toContain("\u001b[32mmcp config: ready");
  });

  it("colors install action tokens without coloring whole lines", async () => {
    const cli = createCliHarness(roots, { colors: true });

    const install = await cli.run("install", "--dry-run");

    expect(install.ok).toBe(true);
    expect(install.output).toContain("install plan:");
    expect(install.output).toContain("\u001b[1minstall plan:\u001b[0m");
    expect(install.output).toContain("\u001b[32mcreate\u001b[0m");
    expect(install.output).toContain("\u001b[33mdry-run\u001b[0m: no files written");
    expect(install.output).not.toContain("\u001b[32m  create");
  });

  it("refuses tracked config writes without force", async () => {
    const cli = createCliHarness(roots);
    const agentsPath = join(cli.root, "AGENTS.md");

    writeFileSync(agentsPath, "# Existing instructions\n");
    execFileSync("git", ["init"], { cwd: cli.root, stdio: "ignore" });
    execFileSync("git", ["add", "AGENTS.md"], { cwd: cli.root, stdio: "ignore" });

    const install = await cli.run("--data-root", cli.dataRoot, "install", "--name", "Tracked Test");

    expect(install.ok).toBe(false);
    expect(install.output).toContain("install plan:");
    expect(install.errors).toContain("blocked tracked config writes:");
    expect(install.errors).toContain("AGENTS.md");
    expect(readFileSync(agentsPath, "utf8")).toBe("# Existing instructions\n");
  });

  it("allows install --force to write tracked config files", async () => {
    const cli = createCliHarness(roots);
    const agentsPath = join(cli.root, "AGENTS.md");
    const claudePath = join(cli.root, "CLAUDE.md");

    writeFileSync(agentsPath, "# Existing instructions\n");
    writeFileSync(claudePath, "# Existing Claude instructions\n");
    execFileSync("git", ["init"], { cwd: cli.root, stdio: "ignore" });
    execFileSync("git", ["add", "AGENTS.md", "CLAUDE.md"], { cwd: cli.root, stdio: "ignore" });

    const install = await cli.run(
      "--data-root",
      cli.dataRoot,
      "install",
      "--name",
      "Tracked Test",
      "--force"
    );

    expect(install.ok).toBe(true);
    expect(install.output).toContain("install plan:");
    expect(install.output).toMatch(/update\s+AGENTS\.md.*\[tracked, commit-safe\]/);
    expect(install.output).toMatch(/update\s+CLAUDE\.md.*\[tracked, commit-safe\]/);
    expect(install.output).toContain("applied writes:");
    expect(install.errors).toBe("");
    const agentsInstructions = readFileSync(agentsPath, "utf8");
    const claudeInstructions = readFileSync(claudePath, "utf8");

    expect(agentsInstructions).toContain("<!-- tachikoma-agent-docs:start -->");
    expect(agentsInstructions).toContain("## Tachikoma");
    expect(agentsInstructions).toContain(
      "When task context is needed, read shared project memory:"
    );
    expect(agentsInstructions).toContain("tachikoma memory");
    expect(agentsInstructions).not.toContain(["memory", "--role"].join(" "));
    expect(claudeInstructions).toContain("<!-- tachikoma-agent-docs:start -->");
    expect(claudeInstructions).toContain(
      "When task context is needed, read shared project memory:"
    );
    expect(claudeInstructions).toContain("tachikoma memory");
    expect(claudeInstructions).not.toContain(["memory", "--role"].join(" "));

    const repeat = await cli.run(
      "--data-root",
      cli.dataRoot,
      "install",
      "--name",
      "Tracked Test",
      "--force",
      "--dry-run"
    );

    expect(repeat.ok).toBe(true);
    expect(repeat.output).toMatch(/skip\s+AGENTS\.md.*\[tracked, commit-safe\]/);
    expect(repeat.output).toMatch(/skip\s+CLAUDE\.md.*\[tracked, commit-safe\]/);
    expect(repeat.output).not.toContain("update AGENTS.md");
    expect(repeat.output).not.toContain("update CLAUDE.md");
  });

  it("prints a dry-run install plan without failing on blocked tracked writes", async () => {
    const cli = createCliHarness(roots);
    const agentsPath = join(cli.root, "AGENTS.md");

    writeFileSync(agentsPath, "# Existing instructions\n");
    execFileSync("git", ["init"], { cwd: cli.root, stdio: "ignore" });
    execFileSync("git", ["add", "AGENTS.md"], { cwd: cli.root, stdio: "ignore" });

    const install = await cli.run(
      "--data-root",
      cli.dataRoot,
      "install",
      "--name",
      "Tracked Test",
      "--dry-run"
    );

    expect(install.ok).toBe(true);
    expect(install.output).toContain("install plan:");
    expect(install.output).toContain("blocked");
    expect(install.output).toContain("dry-run: no files written");
    expect(install.errors).toBe("");
    expect(readFileSync(agentsPath, "utf8")).toBe("# Existing instructions\n");
  });

  it("reports missing store, host hooks, and MCP config without creating a store", async () => {
    const cli = createCliHarness(roots);
    const doctor = await cli.run("--data-root", cli.dataRoot, "doctor");
    const localStorePath = resolveProjectRuntime({
      cwd: cli.root,
      dataRoot: cli.dataRoot
    }).storePath;

    expect(doctor.ok).toBe(true);
    expect(doctor.output).toContain("project config: missing");
    expect(doctor.output).toContain("store: missing");
    expect(doctor.output).toContain("codex hooks: missing");
    expect(doctor.output).toContain("claude hooks: missing");
    expect(doctor.output).toContain("codex skill: missing");
    expect(doctor.output).toContain("claude skill: missing");
    expect(doctor.output).toContain("claude monitor: missing");
    expect(doctor.output).toContain("mcp config: missing");
    expect(doctor.output).toContain("pending inbox: unknown (store missing)");
    expect(existsSync(localStorePath)).toBe(false);
  });

  it("colors reset plan tokens without coloring whole lines", async () => {
    const cli = createCliHarness(roots, { colors: true });

    await cli.run("init");

    const reset = await cli.run("reset", "--dry-run");

    expect(reset.ok).toBe(true);
    // Bold section headers plus isolated presence/summary tokens, never whole lines.
    expect(reset.output).toContain("[1mreset plan:[0m");
    expect(reset.output).toContain("[1mtargets:[0m");
    expect(reset.output).toContain("[31mdelete[0m  ");
    expect(reset.output).toContain("[36mskip[0m  ");
    expect(reset.output).toContain("[33mdry-run[0m: no files deleted");
    expect(reset.output).not.toContain("[31m  delete");
  });

  it("colors doctor status tokens without coloring whole lines", async () => {
    const cli = createCliHarness(roots, { colors: true });

    await cli.run("init");

    const doctor = await cli.run("doctor");

    expect(doctor.ok).toBe(true);
    expect(doctor.output).toContain("store: \u001b[32mok\u001b[0m ");
    expect(doctor.output).toContain("mcp config: \u001b[32mok\u001b[0m ");
    expect(doctor.output).not.toContain("\u001b[32mstore: ok");
  });
});

interface CliHarness {
  root: string;
  dataRoot: string;
  run(...argv: string[]): Promise<CliRunResult>;
  runFrom(cwd: string, ...argv: string[]): Promise<CliRunResult>;
}

interface CliRunResult {
  ok: boolean;
  output: string;
  errors: string;
  error?: unknown;
}

function createCliHarness(roots: string[], options: { colors?: boolean } = {}): CliHarness {
  const root = mkdtempSync(join(tmpdir(), "tachikoma-install-"));
  const dataRoot = join(root, "tachikoma-home");
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    colors: options.colors,
    write: (message) => {
      if (message.length > 0) {
        output.push(message);
      }
    },
    error: (message) => {
      if (message.length > 0) {
        errors.push(message);
      }
    }
  };

  roots.push(root);

  return {
    root,
    dataRoot,
    run: async (...argv: string[]) => {
      return runWithCwd(root, ...argv);
    },
    runFrom: async (cwd: string, ...argv: string[]) => {
      return runWithCwd(cwd, ...argv);
    }
  };

  async function runWithCwd(cwd: string, ...argv: string[]): Promise<CliRunResult> {
    const outputStart = output.length;
    const errorStart = errors.length;

    try {
      await main(argv, {
        cwd,
        io
      });

      return {
        ok: true,
        output: output.slice(outputStart).join("\n"),
        errors: errors.slice(errorStart).join("\n")
      };
    } catch (error) {
      return {
        ok: false,
        output: output.slice(outputStart).join("\n"),
        errors: errors.slice(errorStart).join("\n"),
        error
      };
    }
  }
}
