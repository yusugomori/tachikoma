import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sqliteFileDiagnostics, sqliteWalWarning } from "../../src/cli/commands/doctor.js";
import { main } from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/io.js";
import { createEvent } from "../../src/domain/events.js";
import { EventStore } from "../../src/store/event-store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const TACHIKOMA_IDENTITY_ENV_KEYS = [
  "TACHIKOMA_AGENT_NAME",
  "TACHIKOMA_ACTOR_NAME",
  "TACHIKOMA_RUNTIME",
  "TACHIKOMA_ACTOR_RUNTIME",
  "TACHIKOMA_SESSION_ID",
  "TACHIKOMA_ACTOR_SESSION",
  "TACHIKOMA_ROLE",
  "TACHIKOMA_ACTOR_ROLE"
] as const;
const isolatedEnv = snapshotTachikomaIdentityEnv();

describe("CLI commands", () => {
  const roots: string[] = [];

  const claudeCommandEnv = process.env.TACHIKOMA_CLAUDE_COMMAND;

  beforeEach(() => {
    clearTachikomaIdentityEnv();
    // Pin the claude command so dry-run output is deterministic regardless of
    // whether the host machine resolves `claude` from PATH or a local install.
    process.env.TACHIKOMA_CLAUDE_COMMAND = "claude";
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }

    restoreTachikomaIdentityEnv(isolatedEnv);
    restoreEnv("TACHIKOMA_CLAUDE_COMMAND", claudeCommandEnv);
  });

  it("supports init, named agents, ask, inbox, review loop, status, thread, and memory", async () => {
    const cli = createCliHarness(roots);

    expect(await cli.run("init")).toContain("initialized project: cli-test");
    expect(
      await cli.run("agent", "register", "loki", "--runtime", "codex", "--role", "reviewer")
    ).toContain("registered agent: loki");
    await cli.run("agent", "register", "musashi", "--runtime", "claude", "--role", "implementer");

    const ask = await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "ask",
      "musashi",
      "fix open findings"
    );
    const threadId = extract("conversation", ask);

    expect(ask).toContain("assignment:");

    const claudeInbox = await cli.run("inbox", "--as", "musashi");
    expect(claudeInbox).toContain("[queued]");
    expect(claudeInbox).toContain("fix open findings");

    const session = await cli.run("session", "start", "--name", "musashi");
    expect(session).toContain("claimed: 1");
    expect(await cli.run("inbox", "--as", "musashi")).toContain("[claimed]");

    await cli.run(
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "implementer",
      "reply",
      threadId,
      "I fixed the findings"
    );

    const codexInbox = await cli.run("inbox", "--as", "loki");
    expect(codexInbox).toContain(threadId);
    expect(codexInbox).toContain("I fixed the findings");

    const claim = await cli.run(
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "implementer",
      "claim",
      "record",
      "--thread",
      threadId,
      "--summary",
      "implemented requested changes",
      "--expect",
      "pnpm test",
      "--request-review",
      "--reviewer",
      "loki"
    );
    const claimId = extract("claim", claim);
    const requestId = extract("review_request", claim);

    const finding = await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "review",
      "finding",
      "--thread",
      threadId,
      "--request",
      requestId,
      "--claim",
      claimId,
      "--summary",
      "Missing cleanup path",
      "--to",
      "musashi"
    );
    const findingId = extract("review_finding", finding);

    await cli.run(
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "implementer",
      "review",
      "address",
      "--thread",
      threadId,
      "--request",
      requestId,
      "--claim",
      claimId,
      "--finding",
      findingId,
      "--summary",
      "cleanup path added",
      "--reviewer",
      "loki"
    );

    await cli.run(
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "implementer",
      "verification",
      "record",
      "--thread",
      threadId,
      "--claim",
      claimId,
      "--status",
      "passed",
      "--summary",
      "pnpm test passed",
      "--command",
      "pnpm test"
    );

    const thread = await cli.run("thread", "show", threadId);
    expect(thread).toContain("fix open findings");
    expect(thread).toContain("I fixed the findings");
    expect(thread).toContain("assignment ");
    expect(thread).toContain("review_request ");
    expect(thread).toContain("review_finding ");
    expect(thread).toContain("verification_result ");

    const status = await cli.run("status");
    expect(status).toContain("Project: CLI Test");
    expect(status).toContain("Open conversations:");
    expect(status).toContain("Pending inbox:");

    const memory = await cli.run("memory");
    expect(memory).toContain("Project: CLI Test");
    expect(memory).toContain("Pending inbox:");
    expect(memory.split("\n").some((line) => line.startsWith("Role:"))).toBe(false);
    await expect(cli.run("memory", "--role", "reviewer")).rejects.toThrow(
      /unknown option '--role'/
    );
  });

  it("uses an explicit store without creating the default local state store", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    expect(existsSync(cli.storePath)).toBe(true);
    expect(existsSync(join(cli.root, ".tachikoma", "project.toml"))).toBe(true);
    expect(existsSync(join(cli.root, ".tachikoma", "state", "tachikoma.sqlite"))).toBe(false);
  });

  it("doctor reports real event counts beyond 1000 and observes SQLite files", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    const store = SqliteStore.open(cli.storePath);

    try {
      const eventStore = new EventStore(store.db);
      const events = Array.from({ length: 1005 }, (_, index) =>
        createEvent(
          {
            id: `evt_doctor_${index}`,
            projectId: "cli-test",
            type: "message.sent",
            target: {
              conversationId: "conv_doctor",
              messageId: `msg_doctor_${index}`
            },
            payload: {
              sender: {
                kind: "system"
              },
              recipients: [
                {
                  kind: "agent",
                  name: "loki"
                }
              ],
              body: `doctor count ${index}`,
              replyPolicy: "none",
              linkedRecords: []
            }
          },
          "2026-06-01T00:00:00.000Z"
        )
      );

      eventStore.appendBatch(events);
    } finally {
      store.close();
    }

    const before = sqliteFileDiagnostics(cli.storePath);
    const doctor = await cli.run("doctor");
    const after = sqliteFileDiagnostics(cli.storePath);

    expect(doctor).toContain("events: 1006");
    expect(doctor).toContain("sqlite journal_mode:");
    expect(doctor).toContain("sqlite main:");
    expect(doctor).toContain("sqlite wal:");
    expect(doctor).toContain("sqlite shm:");
    expect(after).toEqual(before);
  });

  it("reports SQLite sibling diagnostics for present and missing files", () => {
    const root = mkdtempSync(join(tmpdir(), "tachikoma-cli-sqlite-files-"));
    roots.push(root);
    const storePath = join(root, "tachikoma.sqlite");

    writeFileSync(storePath, "main");
    writeFileSync(`${storePath}-wal`, "wal is intentionally larger than main");

    const diagnostics = sqliteFileDiagnostics(storePath);

    expect(diagnostics).toEqual([
      {
        label: "main",
        path: storePath,
        bytes: 4
      },
      {
        label: "wal",
        path: `${storePath}-wal`,
        bytes: 37
      },
      {
        label: "shm",
        path: `${storePath}-shm`
      }
    ]);
    expect(sqliteWalWarning(diagnostics)).toContain("sqlite wal warning:");
  });

  it("lets a running agent name itself with join", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    const join = await cli.run("join", "musashi", "--runtime", "claude");

    expect(join).toContain("agent: musashi (created)");
    expect(join).toContain("runtime: claude");
    expect(join).toContain("role: none");
    expect(join).toContain("claimed: 0");

    const roleJoin = await cli.run(
      "join",
      "tachikoma-review",
      "--runtime",
      "claude",
      "--role",
      "tachikoma-logic-reviewer"
    );
    expect(roleJoin).toContain("role: tachikoma-logic-reviewer");

    const ask = await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "ask",
      "musashi",
      "please pick this up from the joined session"
    );
    const threadId = extract("conversation", ask);

    const inbox = await cli.run("inbox", "--as", "musashi");
    expect(inbox).toContain(threadId);
    expect(inbox).toContain("please pick this up from the joined session");
  });

  it("exposes runtime command shells", async () => {
    const cli = createCliHarness(roots);

    const claudeHelp = await cli.run("claude", "--help");
    const codexHelp = await cli.run("codex", "--help");
    const claudeStatus = await cli.run("claude", "status");
    const codexStatus = await cli.run("codex", "status");

    expect(claudeHelp).toContain("Start or inspect the Claude Tachikoma runtime.");
    expect(claudeHelp).not.toContain("--watch");
    expect(claudeHelp).not.toContain("--no-monitor");
    expect(claudeHelp).not.toContain("--monitor");
    expect(codexHelp).toContain("Start or inspect the Codex Tachikoma runtime.");
    expect(codexHelp).toContain("--watch");
    expect(codexHelp).not.toContain("--attach");
    expect(claudeStatus).toContain("claude hooks:");
    expect(claudeStatus).toContain("mcp config:");
    expect(claudeStatus).toContain("claude agents: none");
    expect(codexStatus).toContain("codex app-server: none");
  });

  it("launches Claude TUI by default and reports status", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    const joined = await cli.run(
      "claude",
      "--name",
      "musashi",
      "--role",
      "implementer",
      "--dry-run"
    );
    const status = await cli.run("claude", "status", "--name", "musashi");

    expect(joined).toContain("agent: musashi");
    expect(joined).toContain("delivery_mode: both");
    expect(joined).toContain("tui command: claude --name musashi");
    // The harness root is a plain temp dir, not a tachikoma source checkout,
    // so the monitor command must invoke the global `tachikoma` binary rather
    // than `pnpm --dir <cwd>` (which fails when <cwd> has no package.json).
    expect(joined).toContain("monitor command: tachikoma --cwd");
    expect(joined).not.toContain("monitor command: pnpm --dir");
    expect(joined).toContain("hook monitor --name musashi --watch --poll-ms 1000 --max-items 5");
    expect(joined).toContain("claude tui: claude --name musashi /tachikoma-boot");
    expect(joined).toContain("boot prompt: enabled");
    expect(joined).not.toContain("First tool action must be Claude Code");
    expect(joined).not.toContain('"persistent":true');
    expect(joined).toContain("env: TACHIKOMA_AGENT_NAME=musashi");
    expect(joined).toContain("env: TACHIKOMA_MONITOR_COMMAND=tachikoma --cwd");
    expect(joined).toContain("dry-run: Claude TUI not started");
    expect(status).toContain("musashi: live");
    expect(status).toContain("pending messages: 0");
  });

  it("drives the monitor command through pnpm inside a tachikoma source checkout", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    // Make the harness root look like a tachikoma source checkout so the CLI
    // routes the monitor command through local sources via `pnpm --dir`.
    writeFileSync(
      join(cli.root, "package.json"),
      JSON.stringify({
        name: "@yusugomori/tachikoma",
        scripts: { tachikoma: "tsx src/cli/index.ts" }
      })
    );
    mkdirSync(join(cli.root, "src", "cli"), { recursive: true });
    writeFileSync(join(cli.root, "src", "cli", "index.ts"), "");

    const joined = await cli.run(
      "claude",
      "--name",
      "musashi",
      "--role",
      "implementer",
      "--dry-run"
    );

    expect(joined).toContain("monitor command: pnpm --dir");
    expect(joined).toContain("env: TACHIKOMA_MONITOR_COMMAND=pnpm --dir");
    expect(joined).toContain("hook monitor --name musashi --watch --poll-ms 1000 --max-items 5");
  });

  it("can opt out of Claude auto boot prompt", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    const joined = await cli.run("claude", "--name", "musashi", "--dry-run", "--no-auto-boot");

    expect(joined).toContain("agent: musashi");
    expect(joined).toContain("claude tui: claude --name musashi");
    expect(joined).toContain("boot prompt: disabled");
    expect(joined).not.toContain("/tachikoma-boot");
  });

  it("fuels runtimes by oil grade", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    const claudeNatural = await cli.run("oil", "claude", "--name", "oil-claude", "--dry-run");
    expect(claudeNatural).toContain("--name oil-claude --effort max --settings");
    expect(claudeNatural).toContain('"CLAUDE_CODE_EFFORT_LEVEL":"max"');

    const claudeSynthetic = await cli.run(
      "oil",
      "claude",
      "--name",
      "oil-claude-lite",
      "--synthetic",
      "--dry-run"
    );
    expect(claudeSynthetic).toContain("--name oil-claude-lite --effort low --settings");
    // The chosen effort must be pinned via --settings (flagSettings), otherwise a
    // CLAUDE_CODE_EFFORT_LEVEL in the user's settings env outranks the --effort flag.
    expect(claudeSynthetic).toContain('"CLAUDE_CODE_EFFORT_LEVEL":"low"');
    expect(claudeSynthetic).toContain("/tachikoma-boot");

    const codexNatural = await cli.run("oil", "codex", "--name", "oil-codex", "--dry-run");
    expect(codexNatural).toContain(
      "app-server command: codex -c model_reasoning_effort=xhigh -c service_tier=fast app-server --listen"
    );
    expect(codexNatural).toContain("-c service_tier=fast --remote");
    expect(codexNatural).toContain("dry-run: Codex app-server not started");

    const codexSynthetic = await cli.run(
      "oil",
      "codex",
      "--name",
      "oil-codex-lite",
      "--synthetic",
      "--dry-run"
    );
    expect(codexSynthetic).toContain(
      "app-server command: codex -c model_reasoning_effort=low -c service_tier=default app-server --listen"
    );
    expect(codexSynthetic).not.toContain("service_tier=fast");
    expect(codexSynthetic).not.toContain("xhigh");
  });

  it("passes effort and codex config through the base runtimes and validates input", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    const claude = await cli.run("claude", "--name", "eff", "--effort", "xhigh", "--dry-run");
    expect(claude).toContain("claude tui: claude --name eff --effort xhigh --settings");
    expect(claude).toContain('"CLAUDE_CODE_EFFORT_LEVEL":"xhigh"');
    expect(claude).toContain("/tachikoma-boot");

    const oilHelp = await cli.run("oil");
    expect(oilHelp).toContain("No oil runtime specified");

    await expect(
      cli.run("claude", "--name", "bad", "--effort", "bogus", "--dry-run")
    ).rejects.toThrow(/--effort must be one of/);
  });

  it("runs Claude monitor delivery through hook monitor for a Claude TUI session", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("join", "loki", "--runtime", "codex");
    await cli.run("claude", "--name", "musashi", "--dry-run");
    await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "ask",
      "--reply-policy",
      "optional",
      "musashi",
      "deliver this through tachikoma claude monitor"
    );

    const monitor = await cli.run(
      "hook",
      "monitor",
      "--name",
      "musashi",
      "--watch",
      "--idle-timeout-ms",
      "50",
      "--poll-ms",
      "1"
    );

    expect(monitor).toContain("Tachikoma delivered 1 message(s) for musashi.");
    expect(monitor).toContain(
      "Reply identity: --as musashi --actor-runtime claude --actor-session"
    );
    expect(monitor).toContain("deliver this through tachikoma claude monitor");
  });

  it("treats receive host hooks for not-yet-joined agents as no-op", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    const codexSessionStart = await cli.run(
      "hook",
      "receive",
      "--runtime",
      "codex",
      "--name",
      "loki",
      "--format",
      "codex-json",
      "--event",
      "SessionStart"
    );
    const claudePromptSubmit = await cli.run(
      "hook",
      "receive",
      "--runtime",
      "claude",
      "--name",
      "musashi",
      "--format",
      "claude-json",
      "--event",
      "UserPromptSubmit"
    );

    expect(codexSessionStart).toBe("");
    expect(claudePromptSubmit).toBe("");
  });

  it("surfaces unbound launcher identity diagnostics for bare tachikoma prompts", async () => {
    const cli = createCliHarness(roots);
    const previousName = process.env.TACHIKOMA_AGENT_NAME;
    const previousRuntime = process.env.TACHIKOMA_RUNTIME;
    const previousSession = process.env.TACHIKOMA_SESSION_ID;

    await cli.run("init");
    await cli.run(
      "hook",
      "session-start",
      "--name",
      "codex-01",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    await cli.run(
      "hook",
      "session-start",
      "--name",
      "codex-02",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );

    delete process.env.TACHIKOMA_AGENT_NAME;
    delete process.env.TACHIKOMA_RUNTIME;
    delete process.env.TACHIKOMA_SESSION_ID;

    try {
      const output = await cli.runWithStdin(
        JSON.stringify({
          session_id: "plain_codex_host",
          hook_event_name: "UserPromptSubmit",
          prompt: "$tachikoma 君の名は？"
        }),
        "hook",
        "receive",
        "--runtime",
        "codex",
        "--format",
        "codex-json"
      );
      const parsed = JSON.parse(output) as {
        hookSpecificOutput?: { additionalContext?: string };
      };

      expect(parsed.hookSpecificOutput?.additionalContext).toContain(
        "Tachikoma launcher identity is not bound for this Codex host session."
      );
      expect(parsed.hookSpecificOutput?.additionalContext).toContain(
        "Live codex candidates: codex-01 session="
      );
      expect(parsed.hookSpecificOutput?.additionalContext).toContain("codex-02 session=");
      expect(parsed.hookSpecificOutput?.additionalContext).toContain(
        "do not choose among multiple live candidates"
      );
    } finally {
      restoreEnv("TACHIKOMA_AGENT_NAME", previousName);
      restoreEnv("TACHIKOMA_RUNTIME", previousRuntime);
      restoreEnv("TACHIKOMA_SESSION_ID", previousSession);
    }
  });

  it("uses Tachikoma environment binding for host hook delivery", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("join", "loki", "--runtime", "codex");
    await cli.run("join", "musashi", "--runtime", "claude", "--delivery-mode", "both");
    await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "ask",
      "musashi",
      "deliver this through env-bound claude hook"
    );

    const previousName = process.env.TACHIKOMA_AGENT_NAME;
    const previousRuntime = process.env.TACHIKOMA_RUNTIME;

    process.env.TACHIKOMA_AGENT_NAME = "musashi";
    process.env.TACHIKOMA_RUNTIME = "claude";

    try {
      const output = await cli.run(
        "hook",
        "receive",
        "--runtime",
        "claude",
        "--format",
        "text",
        "--event",
        "UserPromptSubmit"
      );

      expect(output).toContain("Tachikoma delivered 1 message(s) for musashi.");
      expect(output).toContain("deliver this through env-bound claude hook");
    } finally {
      restoreEnv("TACHIKOMA_AGENT_NAME", previousName);
      restoreEnv("TACHIKOMA_RUNTIME", previousRuntime);
    }
  });

  it("keeps a Codex host identity when a tachikoma prompt names another agent", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("join", "codex-01", "--runtime", "codex", "--delivery-mode", "realtime");
    const ownSession = extract(
      "session",
      await cli.run("join", "codex-02", "--runtime", "codex", "--delivery-mode", "realtime")
    );

    const previousName = process.env.TACHIKOMA_AGENT_NAME;
    const previousActorName = process.env.TACHIKOMA_ACTOR_NAME;
    const previousRuntime = process.env.TACHIKOMA_RUNTIME;
    const previousActorRuntime = process.env.TACHIKOMA_ACTOR_RUNTIME;
    const previousSession = process.env.TACHIKOMA_SESSION_ID;
    const previousActorSession = process.env.TACHIKOMA_ACTOR_SESSION;

    delete process.env.TACHIKOMA_AGENT_NAME;
    delete process.env.TACHIKOMA_ACTOR_NAME;
    delete process.env.TACHIKOMA_ACTOR_RUNTIME;
    delete process.env.TACHIKOMA_ACTOR_SESSION;
    process.env.TACHIKOMA_RUNTIME = "codex";
    process.env.TACHIKOMA_SESSION_ID = ownSession;

    try {
      await cli.runWithStdin(
        JSON.stringify({
          session_id: "host_codex_02",
          hook_event_name: "UserPromptSubmit",
          prompt: "$tachikoma 君の名は？"
        }),
        "hook",
        "receive",
        "--runtime",
        "codex",
        "--format",
        "codex-json"
      );
      const followup = await cli.runWithStdin(
        JSON.stringify({
          session_id: "host_codex_02",
          hook_event_name: "UserPromptSubmit",
          prompt: "$tachikoma codex-01 と ping pong して"
        }),
        "hook",
        "receive",
        "--runtime",
        "codex",
        "--format",
        "codex-json"
      );
      const parsed = JSON.parse(followup) as {
        hookSpecificOutput?: { additionalContext?: string };
      };

      expect(parsed.hookSpecificOutput?.additionalContext).toContain("Agent: codex-02");
      expect(parsed.hookSpecificOutput?.additionalContext).toContain(`Session: ${ownSession}`);
      expect(parsed.hookSpecificOutput?.additionalContext).not.toContain("Agent: codex-01");
    } finally {
      restoreEnv("TACHIKOMA_AGENT_NAME", previousName);
      restoreEnv("TACHIKOMA_ACTOR_NAME", previousActorName);
      restoreEnv("TACHIKOMA_RUNTIME", previousRuntime);
      restoreEnv("TACHIKOMA_ACTOR_RUNTIME", previousActorRuntime);
      restoreEnv("TACHIKOMA_SESSION_ID", previousSession);
      restoreEnv("TACHIKOMA_ACTOR_SESSION", previousActorSession);
    }
  });

  it("keeps a Claude host identity when a tachikoma prompt names another agent", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("join", "claude-01", "--runtime", "claude", "--delivery-mode", "both");
    const ownSession = extract(
      "session",
      await cli.run("join", "claude-02", "--runtime", "claude", "--delivery-mode", "both")
    );

    const previousName = process.env.TACHIKOMA_AGENT_NAME;
    const previousActorName = process.env.TACHIKOMA_ACTOR_NAME;
    const previousRuntime = process.env.TACHIKOMA_RUNTIME;
    const previousActorRuntime = process.env.TACHIKOMA_ACTOR_RUNTIME;
    const previousSession = process.env.TACHIKOMA_SESSION_ID;
    const previousActorSession = process.env.TACHIKOMA_ACTOR_SESSION;

    delete process.env.TACHIKOMA_AGENT_NAME;
    delete process.env.TACHIKOMA_ACTOR_NAME;
    delete process.env.TACHIKOMA_ACTOR_RUNTIME;
    delete process.env.TACHIKOMA_ACTOR_SESSION;
    process.env.TACHIKOMA_RUNTIME = "claude";
    process.env.TACHIKOMA_SESSION_ID = ownSession;

    try {
      await cli.runWithStdin(
        JSON.stringify({
          session_id: "host_claude_02",
          hook_event_name: "UserPromptSubmit",
          prompt: "/tachikoma 君の名は？"
        }),
        "hook",
        "receive",
        "--runtime",
        "claude",
        "--format",
        "claude-json"
      );
      const followup = await cli.runWithStdin(
        JSON.stringify({
          session_id: "host_claude_02",
          hook_event_name: "UserPromptSubmit",
          prompt: "/tachikoma claude-01 と ping pong して"
        }),
        "hook",
        "receive",
        "--runtime",
        "claude",
        "--format",
        "claude-json"
      );
      const parsed = JSON.parse(followup) as {
        hookSpecificOutput?: { additionalContext?: string };
      };

      expect(parsed.hookSpecificOutput?.additionalContext).toContain("Agent: claude-02");
      expect(parsed.hookSpecificOutput?.additionalContext).toContain(`Session: ${ownSession}`);
      expect(parsed.hookSpecificOutput?.additionalContext).not.toContain("Agent: claude-01");
    } finally {
      restoreEnv("TACHIKOMA_AGENT_NAME", previousName);
      restoreEnv("TACHIKOMA_ACTOR_NAME", previousActorName);
      restoreEnv("TACHIKOMA_RUNTIME", previousRuntime);
      restoreEnv("TACHIKOMA_ACTOR_RUNTIME", previousActorRuntime);
      restoreEnv("TACHIKOMA_SESSION_ID", previousSession);
      restoreEnv("TACHIKOMA_ACTOR_SESSION", previousActorSession);
    }
  });

  it("prefers launcher agent env over fallback names for name-less tachikoma prompts", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("join", "claude-01", "--runtime", "claude", "--delivery-mode", "both");
    await cli.run(
      "--as",
      "codex-01",
      "--actor-runtime",
      "codex",
      "ask",
      "claude-01",
      "deliver this to launcher-named claude"
    );

    const previousName = process.env.TACHIKOMA_AGENT_NAME;
    const previousRuntime = process.env.TACHIKOMA_RUNTIME;

    process.env.TACHIKOMA_AGENT_NAME = "claude-01";
    process.env.TACHIKOMA_RUNTIME = "claude";

    try {
      const output = await cli.runWithStdin(
        JSON.stringify({
          session_id: "host_claude_01",
          hook_event_name: "UserPromptSubmit",
          prompt: "/tachikoma"
        }),
        "hook",
        "receive",
        "--runtime",
        "claude",
        "--format",
        "claude-json"
      );

      expect(JSON.parse(output)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: expect.stringContaining("deliver this to launcher-named claude")
        }
      });
      expect(output).toContain("for claude-01");
    } finally {
      restoreEnv("TACHIKOMA_AGENT_NAME", previousName);
      restoreEnv("TACHIKOMA_RUNTIME", previousRuntime);
    }
  });

  it("keeps Claude dry-run side-effect free for launcher pending state", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    const joined = await cli.run("claude", "--name", "claude-01", "--dry-run");
    await cli.run(
      "--as",
      "codex-01",
      "--actor-runtime",
      "codex",
      "ask",
      "claude-01",
      "deliver this to pending-bound claude"
    );

    const output = await cli.runWithStdin(
      JSON.stringify({
        session_id: "host_claude_01",
        hook_event_name: "UserPromptSubmit",
        prompt: "/tachikoma-boot"
      }),
      "hook",
      "receive",
      "--runtime",
      "claude",
      "--format",
      "claude-json"
    );

    expect(joined).toContain("claude tui: claude --name claude-01 /tachikoma-boot");
    expect(joined).not.toContain("/tachikoma-boot agent=");
    expect(JSON.parse(output)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining(
          "Tachikoma launcher identity is not bound for this Claude host session."
        )
      }
    });
    expect(output).not.toContain("deliver this to pending-bound claude");
  });

  it("does not route bare tachikoma boot prompts to sample fallback names", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("join", "musashi", "--runtime", "claude", "--delivery-mode", "both");
    await cli.run(
      "--as",
      "codex-01",
      "--actor-runtime",
      "codex",
      "ask",
      "musashi",
      "this should stay queued without a binding"
    );

    const output = await cli.runWithStdin(
      JSON.stringify({
        session_id: "host_unbound_claude",
        hook_event_name: "UserPromptSubmit",
        prompt: "/tachikoma-boot"
      }),
      "hook",
      "receive",
      "--runtime",
      "claude",
      "--format",
      "claude-json"
    );

    expect(JSON.parse(output)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining(
          "Tachikoma launcher identity is not bound for this Claude host session."
        )
      }
    });
    expect(output).not.toContain("this should stay queued without a binding");
  });

  it("resolves receive host hooks through host session binding", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("join", "impl", "--runtime", "claude", "--role", "implementer");
    await cli.run("join", "max", "--runtime", "claude", "--role", "reviewer");
    await cli.run(
      "--as",
      "max",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "reviewer",
      "ask",
      "impl",
      "ping through bound host session"
    );

    const firstReceive = await cli.runWithStdin(
      JSON.stringify({
        session_id: "host_impl_session",
        hook_event_name: "UserPromptSubmit",
        prompt: "/tachikoma-boot impl implementer"
      }),
      "hook",
      "receive",
      "--runtime",
      "claude",
      "--name",
      "musashi",
      "--format",
      "claude-json"
    );

    expect(JSON.parse(firstReceive)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("ping through bound host session")
      }
    });

    await cli.run(
      "--as",
      "max",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "reviewer",
      "ask",
      "impl",
      "second ping through saved host binding"
    );

    const secondReceive = await cli.runWithStdin(
      JSON.stringify({
        session_id: "host_impl_session",
        hook_event_name: "UserPromptSubmit"
      }),
      "hook",
      "receive",
      "--runtime",
      "claude",
      "--format",
      "claude-json"
    );

    expect(JSON.parse(secondReceive)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("second ping through saved host binding")
      }
    });
  });

  it("supports receive and sent host hook commands", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("agent", "register", "loki", "--runtime", "codex", "--role", "reviewer");
    await cli.run("agent", "register", "musashi", "--runtime", "claude", "--role", "implementer");
    await cli.run("hook", "session-start", "--name", "musashi", "--delivery-mode", "turn");

    const firstAsk = await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "ask",
      "--reply-policy",
      "optional",
      "musashi",
      "deliver this through codex stop json"
    );
    const firstMessageId = extract("message", firstAsk);
    const ignoredSent = await cli.runWithStdin(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "mcp__other__noop"
      }),
      "hook",
      "sent",
      "--runtime",
      "codex",
      "--name",
      "loki",
      "--format",
      "codex-json"
    );
    const wakeupSent = await cli.runWithStdin(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "mcp__tachikoma__tachikoma_ask",
        tool_response: {
          structuredContent: {
            messageId: firstMessageId
          }
        }
      }),
      "hook",
      "sent",
      "--runtime",
      "codex",
      "--name",
      "loki",
      "--format",
      "codex-json"
    );
    const autoWakeupSent = await cli.runWithStdin(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "mcp__tachikoma__tachikoma_ask",
        tool_response: {
          structuredContent: {
            messageId: firstMessageId
          }
        }
      }),
      "hook",
      "sent",
      "--runtime",
      "codex",
      "--name",
      "loki"
    );
    const textWakeupSent = await cli.runWithStdin(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "mcp__tachikoma__tachikoma_ask",
        tool_response: {
          structuredContent: {
            messageId: firstMessageId
          }
        }
      }),
      "hook",
      "sent",
      "--runtime",
      "codex",
      "--name",
      "loki",
      "--format",
      "text"
    );

    expect(ignoredSent).toBe("");
    expect(wakeupSent).toBe("");
    expect(autoWakeupSent).toBe("");
    expect(textWakeupSent).toContain("Tachikoma wakeup: 1 inbox item(s)");

    const codexStop = await cli.runWithStdin(
      JSON.stringify({
        hook_event_name: "Stop",
        stop_hook_active: true
      }),
      "hook",
      "receive",
      "--runtime",
      "codex",
      "--name",
      "musashi",
      "--format",
      "codex-json"
    );
    const idleCodexStop = await cli.run(
      "hook",
      "receive",
      "--runtime",
      "codex",
      "--name",
      "musashi",
      "--format",
      "codex-json",
      "--event",
      "Stop"
    );

    expect(JSON.parse(codexStop)).toMatchObject({
      decision: "block"
    });
    expect(codexStop).toContain("deliver this through codex stop json");
    expect(idleCodexStop).toBe("");

    await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "ask",
      "--reply-policy",
      "optional",
      "musashi",
      "deliver this through claude stop json"
    );

    const claudeStop = await cli.run(
      "hook",
      "receive",
      "--runtime",
      "claude",
      "--name",
      "musashi",
      "--format",
      "claude-json",
      "--event",
      "Stop"
    );

    expect(JSON.parse(claudeStop)).toMatchObject({
      decision: "block"
    });
    expect(claudeStop).toContain("deliver this through claude stop json");

    await cli.run("join", "loki", "--runtime", "codex");
    await cli.run(
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "implementer",
      "ask",
      "loki",
      "inject this as codex user prompt context"
    );

    const codexUserPromptContext = await cli.runWithStdin(
      JSON.stringify({
        session_id: "codex_host_session",
        hook_event_name: "UserPromptSubmit",
        prompt: "$tachikoma-boot loki 自分の名前は？"
      }),
      "hook",
      "receive",
      "--runtime",
      "codex",
      "--format",
      "codex-json"
    );

    const parsedCodexUserPromptContext = JSON.parse(codexUserPromptContext) as Record<
      string,
      unknown
    >;

    expect(parsedCodexUserPromptContext).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining("inject this as codex user prompt context")
      }
    });
    expect(parsedCodexUserPromptContext).not.toHaveProperty("additionalContext");

    await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "ask",
      "musashi",
      "inject this as startup context"
    );

    const sessionStartContext = await cli.run(
      "hook",
      "receive",
      "--runtime",
      "codex",
      "--name",
      "musashi",
      "--format",
      "codex-json",
      "--event",
      "SessionStart"
    );

    const parsedSessionStartContext = JSON.parse(sessionStartContext) as Record<string, unknown>;

    expect(parsedSessionStartContext).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.stringContaining("inject this as startup context")
      }
    });
    expect(parsedSessionStartContext).not.toHaveProperty("additionalContext");
    expect(parsedSessionStartContext).not.toHaveProperty("decision");
  });

  it("supports monitor one-shot and watch delivery modes", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("agent", "register", "loki", "--runtime", "codex", "--role", "reviewer");
    await cli.run("agent", "register", "musashi", "--runtime", "claude", "--role", "implementer");
    await cli.run("hook", "session-start", "--name", "musashi", "--delivery-mode", "monitor");
    await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "ask",
      "--reply-policy",
      "optional",
      "musashi",
      "deliver this through monitor one-shot"
    );

    const oneShot = await cli.run("hook", "monitor", "--name", "musashi");
    const idleWatch = await cli.run(
      "hook",
      "monitor",
      "--name",
      "musashi",
      "--watch",
      "--idle-timeout-ms",
      "50",
      "--poll-ms",
      "1"
    );

    await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "ask",
      "--reply-policy",
      "optional",
      "musashi",
      "deliver this through monitor watch"
    );

    const watch = await cli.run(
      "hook",
      "monitor",
      "--name",
      "musashi",
      "--watch",
      "--idle-timeout-ms",
      "50",
      "--poll-ms",
      "1"
    );
    const repeated = await cli.run(
      "hook",
      "monitor",
      "--name",
      "musashi",
      "--watch",
      "--once",
      "--poll-ms",
      "1"
    );

    expect(oneShot).toContain("Tachikoma monitor delivery (monitor)");
    expect(oneShot).toContain("deliver this through monitor one-shot");
    expect(idleWatch).toBe("");
    expect(watch).toContain("Tachikoma delivered 1 message(s) for musashi.");
    expect(watch).toContain("deliver this through monitor watch");
    expect(repeated).toBe("");
  });

  it("shows help without failing when only root options are provided", async () => {
    const cli = createCliHarness(roots);

    const output = await cli.run("--as", "musashi", "--actor-runtime", "claude");

    expect(output).toContain("No command specified.");
    expect(output).toContain("Commands:");
  });

  it("dismisses direct inbox items while preserving thread history", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("agent", "register", "loki", "--runtime", "codex", "--role", "reviewer");
    await cli.run("agent", "register", "musashi", "--runtime", "claude", "--role", "implementer");

    const ask = await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "ask",
      "musashi",
      "stale direct ping"
    );
    const threadId = extract("conversation", ask);

    expect(await cli.run("inbox", "--as", "musashi")).toContain("stale direct ping");

    const dryRun = await cli.run("inbox", "dismiss", "--as", "musashi", "--dry-run");
    expect(dryRun).toContain("dismiss dry-run: musashi direct=1 shared_skipped=0");
    expect(dryRun).toContain("stale direct ping");

    // Dry-run writes nothing: the item is still pending.
    expect(await cli.run("inbox", "--as", "musashi")).toContain("stale direct ping");

    const dismissed = await cli.run("inbox", "dismiss", "--as", "musashi");
    expect(dismissed).toContain("dismissed inbox: musashi count=1");

    const afterDismiss = await cli.run("inbox", "--as", "musashi");
    expect(afterDismiss).toContain("inbox: musashi (0)");
    expect(afterDismiss).not.toContain("stale direct ping");

    // History is preserved even though the inbox item is dismissed.
    expect(await cli.run("thread", "show", threadId)).toContain("stale direct ping");
  });

  it("resolves the dismiss target from the global --as option", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("agent", "register", "loki", "--runtime", "codex", "--role", "reviewer");
    await cli.run("agent", "register", "musashi", "--runtime", "claude", "--role", "implementer");
    await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "ask",
      "musashi",
      "stale via global as"
    );

    const dismissed = await cli.run("--as", "musashi", "inbox", "dismiss");
    expect(dismissed).toContain("dismissed inbox: musashi count=1");
    expect(await cli.run("inbox", "--as", "musashi")).toContain("inbox: musashi (0)");
  });

  it("skips shared role inbox items unless --include-shared is given", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("agent", "register", "loki", "--runtime", "codex", "--role", "reviewer");
    await cli.run("agent", "register", "musashi", "--runtime", "claude", "--role", "implementer");

    const ask = await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "ask",
      "musashi",
      "please implement"
    );
    const threadId = extract("conversation", ask);

    // Recording a claim queues a shared role:reviewer coordination item that loki sees.
    await cli.run(
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "implementer",
      "claim",
      "record",
      "--thread",
      threadId,
      "--summary",
      "implemented the change"
    );

    expect(await cli.run("inbox", "--as", "loki")).toContain("role:reviewer");

    const dryRun = await cli.run("inbox", "dismiss", "--as", "loki", "--dry-run");
    expect(dryRun).toContain("dismiss dry-run: loki direct=0 shared_skipped=1");
    expect(dryRun).toContain(
      "shared skipped: 1 (use --include-shared to dismiss role/broadcast items)"
    );

    // Default dismiss leaves the shared item untouched.
    const defaultDismiss = await cli.run("inbox", "dismiss", "--as", "loki");
    expect(defaultDismiss).toContain("dismissed inbox: loki count=0");
    expect(await cli.run("inbox", "--as", "loki")).toContain("role:reviewer");

    const sharedDryRun = await cli.run(
      "inbox",
      "dismiss",
      "--as",
      "loki",
      "--include-shared",
      "--dry-run"
    );
    expect(sharedDryRun).toContain("dismiss dry-run: loki direct=0 shared_included=1");

    const sharedDismiss = await cli.run("inbox", "dismiss", "--as", "loki", "--include-shared");
    expect(sharedDismiss).toContain("dismissed inbox: loki count=1");
    expect(await cli.run("inbox", "--as", "loki")).toContain("inbox: loki (0)");
  });

  it("fails clearly when the dismiss target is missing or unknown", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    await expect(cli.run("inbox", "dismiss")).rejects.toThrow(
      /inbox dismiss requires --as <agent_name>/
    );
    await expect(cli.run("inbox", "dismiss", "--as", "ghost")).rejects.toThrow(
      /inbox dismiss: unknown agent "ghost"/
    );
  });

  it("previews with reset --dry-run and clears local state with reset --force", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("agent", "register", "loki", "--runtime", "codex", "--role", "reviewer");
    await cli.run("agent", "register", "musashi", "--runtime", "claude", "--role", "implementer");
    await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "ask",
      "musashi",
      "please pick up the open work"
    );

    // Machine-local runtime state that reset should clear (lives under repo .tachikoma/state).
    const stateDir = join(cli.root, ".tachikoma", "state");
    const codexStatePath = join(stateDir, "codex-app-server.json");
    const hostSessionsPath = join(stateDir, "host-sessions.json");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(codexStatePath, '{"schemaVersion":1,"workers":[]}\n');
    writeFileSync(hostSessionsPath, '{"schemaVersion":1,"bindings":[],"pendingLaunches":[]}\n');

    const projectConfigPath = join(cli.root, ".tachikoma", "project.toml");
    const projectConfigBefore = readFileSync(projectConfigPath, "utf8");

    const dryRun = await cli.run("reset", "--dry-run");

    expect(dryRun).toContain("reset plan:");
    expect(dryRun).toContain("targets:");
    expect(dryRun).toMatch(/delete\s+state\/tachikoma\.sqlite\s+event store/);
    // WAL siblings are always planned even when a clean close has checkpointed them away.
    expect(dryRun).toContain("state/tachikoma.sqlite-wal");
    expect(dryRun).toContain("SQLite WAL");
    expect(dryRun).toContain("state/tachikoma.sqlite-shm");
    expect(dryRun).toContain("SQLite shared memory");
    expect(dryRun).toMatch(
      /delete\s+\.tachikoma\/state\/codex-app-server\.json\s+Codex app-server state/
    );
    expect(dryRun).toMatch(
      /delete\s+\.tachikoma\/state\/host-sessions\.json\s+host session bindings/
    );
    expect(dryRun).toMatch(/dry-run: no files deleted \(\d+ to delete, \d+ skipped\)/);

    // Dry-run mutates nothing.
    expect(existsSync(cli.storePath)).toBe(true);
    expect(existsSync(codexStatePath)).toBe(true);
    expect(existsSync(hostSessionsPath)).toBe(true);
    expect(await cli.run("inbox", "--as", "musashi")).toContain("please pick up the open work");
    expect(await cli.run("status")).toContain("musashi");

    const force = await cli.run("reset", "--force");

    expect(force).toContain("reset plan:");
    expect(force).toMatch(/reset: deleted \d+ of \d+ local state file/);
    expect(force).toContain(`store: recreated ${cli.storePath}`);

    // Local runtime state is gone; the store is recreated.
    expect(existsSync(codexStatePath)).toBe(false);
    expect(existsSync(hostSessionsPath)).toBe(false);
    expect(existsSync(cli.storePath)).toBe(true);

    // Commit-safe project identity is preserved untouched.
    expect(existsSync(projectConfigPath)).toBe(true);
    expect(readFileSync(projectConfigPath, "utf8")).toBe(projectConfigBefore);

    // The recreated store keeps the project context but has no prior agents or conversations.
    const status = await cli.run("status");
    expect(status).toContain("Project: CLI Test");
    expect(status).toContain("Agents: 0");
    expect(status).toContain("Open conversations: 0");
    expect(status).toContain("Pending inbox: 0");
    expect(status).not.toContain("loki");
    expect(status).not.toContain("musashi");
  });

  it("reset --force respects an explicit --store and never creates the default store", async () => {
    const cli = createCliHarness(roots);
    const defaultStorePath = join(cli.root, ".tachikoma", "state", "tachikoma.sqlite");

    await cli.run("init");
    await cli.run("agent", "register", "loki", "--runtime", "codex");

    // The harness drives an explicit --store, so the default local store is never created.
    expect(existsSync(cli.storePath)).toBe(true);
    expect(existsSync(defaultStorePath)).toBe(false);

    const reset = await cli.run("reset", "--force");

    expect(reset).toContain(cli.storePath);
    expect(reset).toContain(`store: recreated ${cli.storePath}`);

    // Explicit store recreated empty; default path still untouched.
    expect(existsSync(cli.storePath)).toBe(true);
    expect(existsSync(defaultStorePath)).toBe(false);
    expect(await cli.run("status")).not.toContain("loki");
  });

  it("rejects reset without a mode and with conflicting modes", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    await expect(cli.run("reset")).rejects.toThrow(
      /reset requires --dry-run to preview or --force/
    );
    await expect(cli.run("reset", "--dry-run", "--force")).rejects.toThrow(
      /reset cannot combine --dry-run and --force/
    );
  });

  it("defaults report export and handoff output to .tachikoma/reports", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");

    const report = await cli.run("report", "export");
    expect(report).toMatch(/path: \.tachikoma\/reports\/report_[0-9a-f]+\.md/);
    expect(existsSync(join(cli.root, ".tachikoma", "reports"))).toBe(true);

    const jsonReport = await cli.run("report", "export", "--format", "json");
    expect(jsonReport).toMatch(/path: \.tachikoma\/reports\/report_[0-9a-f]+\.json/);

    const handoff = await cli.run("report", "handoff", "--summary", "wrapping up");
    expect(handoff).toMatch(/path: \.tachikoma\/reports\/handoff_[0-9a-f]+\.md/);

    // An explicit path is still honored verbatim.
    const explicit = await cli.run("report", "export", "docs/custom-report.md");
    expect(explicit).toContain("path: docs/custom-report.md");
  });
});

interface CliHarness {
  root: string;
  storePath: string;
  run(...argv: string[]): Promise<string>;
  runWithStdin(stdin: string, ...argv: string[]): Promise<string>;
}

function createCliHarness(roots: string[]): CliHarness {
  const root = mkdtempSync(join(tmpdir(), "tachikoma-cli-"));
  roots.push(root);
  const storePath = join(root, "state", "tachikoma.sqlite");
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
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

  return {
    root,
    storePath,
    run: async (...argv: string[]) => {
      return runWithStdin("", ...argv);
    },
    runWithStdin
  };

  async function runWithStdin(stdin: string, ...argv: string[]): Promise<string> {
    const start = output.length;

    await main(
      ["--store", storePath, "--project", "cli-test", "--project-name", "CLI Test", ...argv],
      {
        cwd: root,
        io,
        stdin
      }
    );

    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }

    return output.slice(start).join("\n");
  }
}

function extract(label: string, output: string): string {
  const pattern = new RegExp(`^${label}:\\s*(.+)$`, "m");
  const match = pattern.exec(output);

  if (!match?.[1]) {
    throw new Error(`Missing ${label} in output:\n${output}`);
  }

  return match[1].trim();
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function snapshotTachikomaIdentityEnv(): Record<string, string | undefined> {
  return Object.fromEntries(TACHIKOMA_IDENTITY_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function clearTachikomaIdentityEnv(): void {
  for (const key of TACHIKOMA_IDENTITY_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreTachikomaIdentityEnv(values: Record<string, string | undefined>): void {
  for (const key of TACHIKOMA_IDENTITY_ENV_KEYS) {
    restoreEnv(key, values[key]);
  }
}
