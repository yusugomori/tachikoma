import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  type CodexAppServerNotification,
  CodexAppServerRpcError,
  type CodexJsonRpcTransport,
  codexAppServerStatePath,
  codexRemoteControlBindingPath,
  latestAssistantMessage,
  normalizeCodexThreadRead,
  readCodexAppServerWorkers,
  readCodexRemoteControlBindings,
  runCodexAppServerProbe,
  writeCodexAppServerWorker,
  writeCodexRemoteControlBinding
} from "../../src/adapters/index.js";
import { main } from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/io.js";
import { openCliRuntime } from "../../src/cli/runtime.js";
import { CodexDeliveryService } from "../../src/services/index.js";

describe("Codex app-server probe", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sends initialize, thread/list, turn/start, and thread/read for an existing thread", async () => {
    const transport = new RecordingTransport({
      initialize: {},
      "thread/list": {
        data: [
          {
            id: "thread_existing",
            cwd: "/repo",
            status: "idle",
            source: "cli"
          }
        ]
      },
      "turn/start": {
        turn: {
          id: "turn_existing",
          status: "inProgress",
          items: []
        }
      },
      "thread/read": {
        thread: {
          id: "thread_existing"
        }
      }
    });

    const result = await runCodexAppServerProbe(
      {
        cwd: "/repo",
        message: "Tachikoma delivered a probe message."
      },
      new CodexAppServerClient(transport)
    );

    expect(result).toMatchObject({
      status: "accepted",
      threadId: "thread_existing",
      threadOrigin: "existing",
      turnId: "turn_existing"
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/list",
      "turn/start",
      "thread/read"
    ]);
    expect(transport.requests[1]?.params).toMatchObject({
      archived: false,
      cwd: "/repo"
    });
    expect(transport.requests[2]?.params).toMatchObject({
      threadId: "thread_existing",
      cwd: "/repo",
      input: [
        {
          type: "text",
          text: "Tachikoma delivered a probe message."
        }
      ]
    });
    expect(transport.notifications).toEqual([
      {
        method: "initialized",
        params: {}
      }
    ]);
  });

  it("starts a managed thread when no existing thread matches", async () => {
    const transport = new RecordingTransport({
      initialize: {},
      "thread/list": {
        data: []
      },
      "thread/start": {
        thread: {
          id: "thread_started",
          cwd: "/repo",
          status: "idle"
        }
      },
      "turn/start": {
        turn: {
          id: "turn_started",
          status: "inProgress",
          items: []
        }
      },
      "thread/read": {
        thread: {
          id: "thread_started"
        }
      }
    });

    const result = await runCodexAppServerProbe(
      {
        cwd: "/repo",
        message: "Tachikoma delivered a managed-thread probe."
      },
      new CodexAppServerClient(transport)
    );

    expect(result).toMatchObject({
      status: "accepted",
      threadId: "thread_started",
      threadOrigin: "started",
      turnId: "turn_started"
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/list",
      "thread/start",
      "turn/start",
      "thread/read"
    ]);
    expect(transport.requests[2]?.params).toMatchObject({
      cwd: "/repo",
      threadSource: "user"
    });
  });

  it("prefers a loaded cwd thread for foreground Codex TUI delivery", async () => {
    const transport = new RecordingTransport({
      "thread/loaded/list": {
        data: ["thread_tui"]
      },
      "thread/list": {
        data: [
          {
            id: "thread_tui",
            cwd: "/repo",
            status: "idle",
            source: "cli"
          },
          {
            id: "thread_managed",
            cwd: "/repo",
            status: "idle",
            source: "appServer"
          }
        ]
      }
    });

    const result = await new CodexAppServerClient(transport).ensureManagedThread(
      "/repo",
      "thread_managed",
      {
        preferLoadedThread: true
      }
    );

    expect(result).toMatchObject({
      thread: {
        id: "thread_tui"
      },
      threadOrigin: "existing"
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      "thread/loaded/list",
      "thread/list"
    ]);
  });

  it("finds an empty loaded Codex TUI thread before turns are materialized", async () => {
    const transport = new RecordingTransport({
      "thread/loaded/list": {
        data: ["thread_empty_tui"]
      },
      "thread/list": {
        data: []
      },
      "thread/read": {
        thread: {
          id: "thread_empty_tui",
          cwd: "/repo",
          status: {
            type: "idle"
          },
          source: "vscode",
          turns: []
        }
      }
    });

    const result = await new CodexAppServerClient(transport).findLoadedThread("/repo");

    expect(result).toMatchObject({
      id: "thread_empty_tui",
      cwd: "/repo",
      source: "vscode"
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      "thread/loaded/list",
      "thread/list",
      "thread/read"
    ]);
    expect(transport.requests[2]?.params).toEqual({
      threadId: "thread_empty_tui"
    });
  });

  it("waits for completion and accepts the turn when thread/read is still too early", async () => {
    const transport = new RecordingTransport(
      {
        initialize: {},
        "thread/list": {
          data: [
            {
              id: "thread_existing",
              cwd: "/repo",
              status: "idle",
              source: "cli"
            }
          ]
        },
        "turn/start": {
          turn: {
            id: "turn_existing",
            status: "inProgress",
            items: []
          }
        },
        "thread/read": new CodexAppServerRpcError("rollout is empty")
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread_existing",
          turn: {
            id: "turn_existing",
            status: "completed"
          }
        }
      }
    );

    const result = await runCodexAppServerProbe(
      {
        cwd: "/repo",
        message: "Tachikoma delivered a completion probe.",
        waitForCompletionMs: 1000
      },
      new CodexAppServerClient(transport)
    );

    expect(result).toMatchObject({
      status: "accepted",
      threadId: "thread_existing",
      threadOrigin: "existing",
      turnId: "turn_existing",
      completionStatus: "completed",
      readWarning: "rollout is empty"
    });
  });

  it("falls back to a managed thread when an auto-selected existing thread rejects turn/start", async () => {
    const transport = new RecordingTransport({
      initialize: {},
      "thread/list": {
        data: [
          {
            id: "thread_existing",
            cwd: "/repo",
            status: "idle",
            source: "cli"
          }
        ]
      },
      "turn/start": [
        new CodexAppServerRpcError("thread not found: thread_existing"),
        {
          turn: {
            id: "turn_started",
            status: "inProgress",
            items: []
          }
        }
      ],
      "thread/start": {
        thread: {
          id: "thread_started",
          cwd: "/repo",
          status: "idle"
        }
      },
      "thread/read": {
        thread: {
          id: "thread_started"
        }
      }
    });

    const result = await runCodexAppServerProbe(
      {
        cwd: "/repo",
        message: "Tachikoma delivered a fallback probe."
      },
      new CodexAppServerClient(transport)
    );

    expect(result).toMatchObject({
      status: "accepted",
      threadId: "thread_started",
      threadOrigin: "started",
      turnId: "turn_started",
      fallbackReason: "thread not found: thread_existing"
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      "initialize",
      "thread/list",
      "turn/start",
      "thread/start",
      "turn/start",
      "thread/read"
    ]);
    expect(transport.requests[2]?.params).toMatchObject({
      threadId: "thread_existing"
    });
    expect(transport.requests[4]?.params).toMatchObject({
      threadId: "thread_started"
    });
  });

  it("starts a Tachikoma-managed thread instead of auto-selecting user threads", async () => {
    const transport = new RecordingTransport({
      "thread/start": {
        thread: {
          id: "thread_managed",
          cwd: "/repo",
          status: "idle"
        }
      }
    });

    const result = await new CodexAppServerClient(transport).ensureManagedThread("/repo");

    expect(result).toMatchObject({
      thread: {
        id: "thread_managed"
      },
      threadOrigin: "started"
    });
    expect(transport.requests.map((request) => request.method)).toEqual(["thread/start"]);
  });

  it("replaces a preferred managed thread when app-server rejects it", async () => {
    const transport = new RecordingTransport({
      "thread/read": new CodexAppServerRpcError("thread not found: thread_old"),
      "thread/start": {
        thread: {
          id: "thread_new",
          cwd: "/repo",
          status: "idle"
        }
      }
    });

    const result = await new CodexAppServerClient(transport).ensureManagedThread(
      "/repo",
      "thread_old"
    );

    expect(result).toMatchObject({
      thread: {
        id: "thread_new"
      },
      threadOrigin: "started",
      fallbackReason: "thread not found: thread_old"
    });
    expect(transport.requests.map((request) => request.method)).toEqual([
      "thread/read",
      "thread/start"
    ]);
  });

  it("normalizes assistant replies from nested thread/read responses", () => {
    const read = normalizeCodexThreadRead({
      thread: {
        id: "thread_loki",
        turns: [
          {
            id: "turn_1",
            status: "completed",
            items: [
              {
                id: "item_1",
                type: "agentMessage",
                turnId: "turn_1",
                text: "PONG"
              }
            ]
          }
        ]
      }
    });

    expect(read.turns).toEqual([
      {
        id: "turn_1",
        status: "completed"
      }
    ]);
    expect(latestAssistantMessage(read, "turn_1")?.text).toBe("PONG");
  });

  it("lists turn items when thread/read omits full assistant content", async () => {
    const transport = new RecordingTransport({
      "thread/turns/items/list": {
        data: [
          {
            id: "item_1",
            type: "agentMessage",
            text: "PONG",
            phase: "final"
          }
        ],
        nextCursor: null,
        backwardsCursor: "cursor_1"
      }
    });

    const read = await new CodexAppServerClient(transport).listTurnItemsNormalized({
      threadId: "thread_loki",
      turnId: "turn_1"
    });

    expect(latestAssistantMessage(read, "turn_1")?.text).toBe("PONG");
    expect(transport.requests[0]?.params).toMatchObject({
      threadId: "thread_loki",
      turnId: "turn_1"
    });
  });

  it("stores experimental Codex thread bindings under local Tachikoma state", () => {
    const root = mkdtempSync(join(tmpdir(), "tachikoma-codex-binding-"));
    roots.push(root);

    const binding = writeCodexRemoteControlBinding(root, {
      agentName: "loki",
      codexThreadId: "thread_existing",
      cwd: root,
      threadOrigin: "existing",
      lastTurnId: "turn_existing",
      now: "2026-06-01T00:00:00.000Z"
    });

    expect(binding).toMatchObject({
      agentName: "loki",
      codexThreadId: "thread_existing",
      lastTurnId: "turn_existing"
    });
    expect(existsSync(codexRemoteControlBindingPath(root))).toBe(true);
    expect(readCodexRemoteControlBindings(root)).toEqual([binding]);
  });

  it("stores app-server worker state and ignores malformed entries", () => {
    const root = mkdtempSync(join(tmpdir(), "tachikoma-codex-worker-"));
    roots.push(root);

    const worker = writeCodexAppServerWorker(root, {
      agentName: "loki",
      cwd: root,
      serverUrl: "ws://127.0.0.1:48123",
      pid: 48123,
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      sessionId: "sess_loki",
      lifecycle: "daemon",
      now: "2026-06-02T00:00:00.000Z"
    });

    expect(existsSync(codexAppServerStatePath(root))).toBe(true);
    expect(readCodexAppServerWorkers(root)).toEqual([worker]);

    writeFileSync(
      codexAppServerStatePath(root),
      `${JSON.stringify({
        schemaVersion: 1,
        workers: [
          worker,
          {
            agentName: 42,
            cwd: root
          }
        ]
      })}\n`
    );

    expect(readCodexAppServerWorkers(root)).toEqual([worker]);

    writeFileSync(codexAppServerStatePath(root), "not json");
    expect(readCodexAppServerWorkers(root)).toEqual([]);
  });

  it("codex status reports and removes stale worker state", async () => {
    const cli = createCliHarness(roots);

    await cli.run("--store", cli.storePath, "--project", "status-test", "init", "--store-only");
    const joined = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "status-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    const sessionId = extract("session", joined);

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      sessionId,
      lifecycle: "daemon"
    });

    const status = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "status-test",
      "codex",
      "status",
      "--name",
      "loki"
    );

    expect(status).toContain("loki: stale");
    expect(status).toContain("removed stale app-server state: loki");
    expect(readCodexAppServerWorkers(cli.root)).toEqual([]);

    const projectStatus = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "status-test",
      "status"
    );

    expect(projectStatus).toContain("- loki runtime=codex role=none offline");
  });

  it("codex status reports live worker details and pending message count", async () => {
    const cli = createCliHarness(roots);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "status-live-test",
      "init",
      "--store-only"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "status-live-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "status-live-test",
      "ask",
      "loki",
      "Reply exactly PONG"
    );

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      pid: process.pid,
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      sessionId: "sess_loki",
      lifecycle: "daemon"
    });

    const status = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "status-live-test",
      "codex",
      "status",
      "--name",
      "loki"
    );

    expect(status).toContain("loki: live (daemon)");
    expect(status).toContain("pending messages: 1");
    expect(status).toContain("attach: tachikoma codex attach --name loki");
  });

  it("codex attach reads live worker state and supports dry-run", async () => {
    const cli = createCliHarness(roots);

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      pid: process.pid,
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      sessionId: "sess_loki",
      lifecycle: "daemon"
    });

    const output = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "attach-test",
      "codex",
      "attach",
      "--name",
      "loki",
      "--dry-run"
    );

    expect(output).toContain("agent: loki");
    expect(output).toContain("app-server: ws://127.0.0.1:48123");
    expect(output).toContain("attach command: codex --remote ws://127.0.0.1:48123");
    expect(output).toContain("env: TACHIKOMA_AGENT_NAME=loki");
    expect(output).toContain("env: TACHIKOMA_SESSION_ID=sess_loki");
    expect(output).toContain("env: TACHIKOMA_RUNTIME=codex");
  });

  it("passes Tachikoma identity env to the Codex app-server process", async () => {
    const cli = createCliHarness(roots);
    const commandPath = join(cli.root, "fake-codex.js");
    const envPath = join(cli.root, "codex-env.jsonl");
    const previousCommand = process.env.TACHIKOMA_CODEX_COMMAND;
    const previousEnvPath = process.env.TACHIKOMA_TEST_ENV_FILE;

    writeFileSync(
      commandPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");

const envFile = process.env.TACHIKOMA_TEST_ENV_FILE;
const record = (mode) => {
  fs.appendFileSync(
    envFile,
    JSON.stringify({
      mode,
      agentName: process.env.TACHIKOMA_AGENT_NAME,
      sessionId: process.env.TACHIKOMA_SESSION_ID,
      runtime: process.env.TACHIKOMA_RUNTIME,
      deliveryMode: process.env.TACHIKOMA_DELIVERY_MODE
    }) + "\\n"
  );
};

if (process.argv.includes("app-server")) {
  record("app-server");
  const listen = process.argv[process.argv.indexOf("--listen") + 1];
  const port = new URL(listen.replace(/^ws:/, "http:")).port;
  const server = http.createServer((request, response) => {
    if (request.url === "/readyz") {
      response.writeHead(200);
      response.end("ok");
      return;
    }

    response.writeHead(404);
    response.end("not found");
  });
  server.listen(Number(port), "127.0.0.1");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  return;
}

if (process.argv.includes("--remote")) {
  record("attach");
  process.exit(0);
}

process.exit(0);
`
    );
    chmodSync(commandPath, 0o755);
    process.env.TACHIKOMA_CODEX_COMMAND = commandPath;
    process.env.TACHIKOMA_TEST_ENV_FILE = envPath;

    try {
      const output = await cli.run(
        "--store",
        cli.storePath,
        "--project",
        "app-server-env-test",
        "codex",
        "--name",
        "loki"
      );
      const sessionId = extract("session", output);
      const records = readFileSync(envPath, "utf8")
        .trim()
        .split(/\n/)
        .map((line) => JSON.parse(line) as Record<string, string>);

      expect(records.find((record) => record.mode === "app-server")).toMatchObject({
        agentName: "loki",
        sessionId,
        runtime: "codex",
        deliveryMode: "realtime"
      });
      expect(records.find((record) => record.mode === "attach")).toMatchObject({
        agentName: "loki",
        sessionId,
        runtime: "codex",
        deliveryMode: "realtime"
      });
    } finally {
      restoreEnv("TACHIKOMA_CODEX_COMMAND", previousCommand);
      restoreEnv("TACHIKOMA_TEST_ENV_FILE", previousEnvPath);
    }
  });

  it("codex stop accepts --name after the subcommand", async () => {
    const cli = createCliHarness(roots);

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      sessionId: "sess_loki",
      lifecycle: "daemon"
    });

    const output = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "stop-name-test",
      "codex",
      "stop",
      "--name",
      "loki"
    );

    expect(output).toContain("stale: loki");
    expect(readCodexAppServerWorkers(cli.root)).toEqual([]);
  });

  it("codex stop removes only Tachikoma-started stale workers", async () => {
    const cli = createCliHarness(roots);

    const managed = writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      sessionId: "sess_loki",
      lifecycle: "daemon"
    });
    const external = writeCodexAppServerWorker(cli.root, {
      agentName: "external",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48124",
      startedByTachikoma: false,
      codexThreadId: "thread_external",
      lifecycle: "daemon"
    });

    const output = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "stop-test",
      "codex",
      "stop",
      "--all"
    );

    expect(output).toContain(`stale: ${managed.agentName}`);
    expect(output).toContain(`skipped: ${external.agentName} was not started by Tachikoma`);
    expect(readCodexAppServerWorkers(cli.root)).toEqual([external]);
  });

  it("delivers pending inbox through a mocked Codex app-server and records the reply", async () => {
    const cli = createCliHarness(roots);

    await cli.run("--store", cli.storePath, "--project", "delivery-test", "init", "--store-only");
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    const ask = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-test",
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "ask",
      "loki",
      "Reply exactly PONG"
    );
    const threadId = extract("conversation", ask);
    const transport = new RecordingTransport(
      {
        initialize: {},
        "thread/read": [
          {
            thread: {
              id: "thread_loki"
            }
          },
          {
            thread: {
              id: "thread_loki",
              turns: [
                {
                  id: "turn_1",
                  status: "completed",
                  items: [
                    {
                      id: "item_1",
                      type: "agentMessage",
                      turnId: "turn_1",
                      text: "PONG"
                    }
                  ]
                }
              ]
            }
          }
        ],
        "turn/start": {
          turn: {
            id: "turn_1",
            status: "inProgress"
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread_loki",
          turn: {
            id: "turn_1",
            status: "completed"
          }
        }
      }
    );

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      lifecycle: "daemon"
    });

    const runtime = openCliRuntime({
      cwd: cli.root,
      storePath: cli.storePath,
      projectId: "delivery-test"
    });
    try {
      const result = await new CodexDeliveryService(runtime.context, {
        clientFactory: () => ({
          client: new CodexAppServerClient(transport)
        })
      }).deliverPending({
        agentName: "loki",
        waitForCompletionMs: 1000
      });
      const deliveredAttempt = runtime
        .projections()
        .inbox.deliveryAttempts.find((attempt) => attempt.status === "delivered");

      expect(result).toMatchObject({
        attempted: 1,
        delivered: 1,
        failed: 0,
        pending: 0
      });
      expect(deliveredAttempt).toMatchObject({
        deliveryMode: "realtime",
        status: "delivered"
      });
    } finally {
      runtime.close();
    }

    const thread = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-test",
      "thread",
      "show",
      threadId
    );
    const inbox = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-test",
      "inbox",
      "--as",
      "loki"
    );

    expect(thread).toContain("PONG");
    expect(inbox).toBe("inbox: loki (0)");
  });

  it("delivers foreground Codex TUI messages to the loaded thread", async () => {
    const cli = createCliHarness(roots);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-loaded-test",
      "init",
      "--store-only"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-loaded-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-loaded-test",
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "ask",
      "loki",
      "Reply exactly PONG"
    );

    const transport = new RecordingTransport(
      {
        initialize: {},
        "thread/loaded/list": {
          data: ["thread_tui"]
        },
        "thread/list": {
          data: [
            {
              id: "thread_tui",
              cwd: cli.root,
              status: "idle",
              source: "cli"
            }
          ]
        },
        "turn/start": {
          turn: {
            id: "turn_1",
            status: "inProgress"
          }
        },
        "thread/read": {
          thread: {
            id: "thread_tui",
            turns: [
              {
                id: "turn_1",
                status: "completed",
                items: [
                  {
                    id: "item_1",
                    type: "agentMessage",
                    turnId: "turn_1",
                    text: "PONG"
                  }
                ]
              }
            ]
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread_tui",
          turn: {
            id: "turn_1",
            status: "completed"
          }
        }
      }
    );

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      pid: process.pid,
      startedByTachikoma: true,
      codexThreadId: "thread_managed",
      lifecycle: "foreground"
    });

    const runtime = openCliRuntime({
      cwd: cli.root,
      storePath: cli.storePath,
      projectId: "delivery-loaded-test"
    });
    try {
      const result = await new CodexDeliveryService(runtime.context, {
        clientFactory: () => ({
          client: new CodexAppServerClient(transport)
        })
      }).deliverPending({
        agentName: "loki",
        waitForCompletionMs: 1000
      });

      const turnStart = transport.requests.find((request) => request.method === "turn/start");

      expect(result).toMatchObject({
        attempted: 1,
        delivered: 1,
        failed: 0
      });
      expect(turnStart?.params).toMatchObject({
        threadId: "thread_tui"
      });
      expect(JSON.stringify(turnStart?.params)).toContain(
        "records your assistant response back to Tachikoma automatically"
      );
      expect(JSON.stringify(turnStart?.params)).toContain("Do not call tachikoma_reply");
    } finally {
      runtime.close();
    }
  });

  it("keeps foreground Codex TUI messages pending until a loaded thread exists", async () => {
    const cli = createCliHarness(roots);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-wait-loaded-test",
      "init",
      "--store-only"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-wait-loaded-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-wait-loaded-test",
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "ask",
      "loki",
      "Reply exactly PONG"
    );

    const transport = new RecordingTransport({
      initialize: {},
      "thread/loaded/list": {
        data: []
      }
    });

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      pid: process.pid,
      startedByTachikoma: true,
      lifecycle: "foreground"
    });

    const runtime = openCliRuntime({
      cwd: cli.root,
      storePath: cli.storePath,
      projectId: "delivery-wait-loaded-test"
    });
    try {
      const result = await new CodexDeliveryService(runtime.context, {
        clientFactory: () => ({
          client: new CodexAppServerClient(transport)
        })
      }).deliverPending({
        agentName: "loki",
        waitForCompletionMs: 1000
      });

      expect(result).toMatchObject({
        attempted: 0,
        delivered: 0,
        failed: 0,
        pending: 1
      });
      expect(result.warnings).toContain(
        "Codex TUI delivery is waiting for a loaded TUI thread for loki. Open it with `tachikoma codex --name loki` or `tachikoma codex attach --name loki`."
      );
      expect(transport.requests.map((request) => request.method)).toEqual([
        "initialize",
        "thread/loaded/list"
      ]);
    } finally {
      runtime.close();
    }
  });

  it("matches foreground Codex TUI threads through realpath-equivalent cwd aliases", async () => {
    const physicalRoot = createCliHarness(roots);
    const logicalRoot = join(tmpdir(), `tachikoma-codex-alias-${Date.now()}`);
    symlinkSync(physicalRoot.root, logicalRoot, "dir");
    roots.push(logicalRoot);

    await physicalRoot.run(
      "--store",
      physicalRoot.storePath,
      "--project",
      "delivery-realpath-alias-test",
      "init",
      "--store-only"
    );
    await main(
      [
        "--cwd",
        logicalRoot,
        "--store",
        physicalRoot.storePath,
        "--project",
        "delivery-realpath-alias-test",
        "join",
        "loki",
        "--runtime",
        "codex",
        "--delivery-mode",
        "realtime"
      ],
      { cwd: logicalRoot }
    );
    await main(
      [
        "--cwd",
        logicalRoot,
        "--store",
        physicalRoot.storePath,
        "--project",
        "delivery-realpath-alias-test",
        "--as",
        "musashi",
        "--actor-runtime",
        "claude",
        "ask",
        "loki",
        "Reply exactly PONG"
      ],
      { cwd: logicalRoot }
    );

    const transport = new RecordingTransport(
      {
        initialize: {},
        "thread/loaded/list": {
          data: ["thread_tui"]
        },
        "thread/list": {
          data: []
        },
        "thread/read": [
          {
            thread: {
              id: "thread_tui",
              cwd: physicalRoot.root
            }
          },
          {
            thread: {
              id: "thread_tui",
              turns: [
                {
                  id: "turn_1",
                  status: "completed",
                  items: [
                    {
                      id: "item_1",
                      type: "agentMessage",
                      turnId: "turn_1",
                      text: "PONG"
                    }
                  ]
                }
              ]
            }
          }
        ],
        "turn/start": {
          turn: {
            id: "turn_1",
            status: "inProgress"
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread_tui",
          turn: {
            id: "turn_1",
            status: "completed"
          }
        }
      }
    );

    writeCodexAppServerWorker(logicalRoot, {
      agentName: "loki",
      cwd: logicalRoot,
      serverUrl: "ws://127.0.0.1:48123",
      pid: process.pid,
      startedByTachikoma: true,
      lifecycle: "foreground"
    });

    const runtime = openCliRuntime({
      cwd: logicalRoot,
      storePath: physicalRoot.storePath,
      projectId: "delivery-realpath-alias-test"
    });
    try {
      const result = await new CodexDeliveryService(runtime.context, {
        clientFactory: () => ({
          client: new CodexAppServerClient(transport)
        })
      }).deliverPending({
        agentName: "loki",
        waitForCompletionMs: 1000
      });

      const turnStart = transport.requests.find((request) => request.method === "turn/start");

      expect(result).toMatchObject({
        attempted: 1,
        delivered: 1,
        failed: 0
      });
      expect(turnStart?.params).toMatchObject({
        threadId: "thread_tui",
        cwd: physicalRoot.root
      });
    } finally {
      runtime.close();
    }
  });

  it("delivers a reply found by polling when completion notifications are missing", async () => {
    const cli = createCliHarness(roots);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-poll-test",
      "init",
      "--store-only"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-poll-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    const ask = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-poll-test",
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "ask",
      "loki",
      "Reply exactly PONG"
    );
    const threadId = extract("conversation", ask);
    const transport = new RecordingTransport({
      initialize: {},
      "thread/read": [
        {
          thread: {
            id: "thread_loki"
          }
        },
        {
          thread: {
            id: "thread_loki",
            turns: [
              {
                id: "turn_1",
                status: "inProgress",
                items: []
              }
            ]
          }
        },
        {
          thread: {
            id: "thread_loki",
            turns: [
              {
                id: "turn_1",
                status: "completed",
                items: [
                  {
                    id: "item_1",
                    type: "agentMessage",
                    turnId: "turn_1",
                    text: "PONG"
                  }
                ]
              }
            ]
          }
        }
      ],
      "thread/turns/items/list": {
        data: []
      },
      "turn/start": {
        turn: {
          id: "turn_1",
          status: "inProgress"
        }
      }
    });

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      lifecycle: "daemon"
    });

    const runtime = openCliRuntime({
      cwd: cli.root,
      storePath: cli.storePath,
      projectId: "delivery-poll-test"
    });
    try {
      const result = await new CodexDeliveryService(runtime.context, {
        clientFactory: () => ({
          client: new CodexAppServerClient(transport)
        })
      }).deliverPending({
        agentName: "loki",
        waitForCompletionMs: 1
      });

      expect(result).toMatchObject({
        attempted: 1,
        delivered: 1,
        failed: 0,
        pending: 0
      });
    } finally {
      runtime.close();
    }

    const thread = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-poll-test",
      "thread",
      "show",
      threadId
    );

    expect(thread).toContain("PONG");
  });

  it("records the current Codex turn reply instead of a stale assistant message", async () => {
    const cli = createCliHarness(roots);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-stale-reply-test",
      "init",
      "--store-only"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-stale-reply-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    const ask = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-stale-reply-test",
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "ask",
      "loki",
      "Choose paper for this janken turn."
    );
    const threadId = extract("conversation", ask);
    const transport = new RecordingTransport(
      {
        initialize: {},
        "thread/read": [
          {
            thread: {
              id: "thread_loki"
            }
          },
          {
            thread: {
              id: "thread_loki",
              turns: [
                {
                  id: "turn_old",
                  status: "completed",
                  items: [
                    {
                      id: "item_old",
                      type: "agentMessage",
                      turnId: "turn_old",
                      text: "✊ グー"
                    }
                  ]
                }
              ]
            }
          }
        ],
        "thread/turns/items/list": {
          data: [
            {
              id: "item_current",
              type: "agentMessage",
              text: "パー(✋)",
              phase: "final"
            }
          ]
        },
        "turn/start": {
          turn: {
            id: "turn_current",
            status: "inProgress"
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread_loki",
          turn: {
            id: "turn_current",
            status: "completed"
          }
        }
      }
    );

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      lifecycle: "daemon"
    });

    const runtime = openCliRuntime({
      cwd: cli.root,
      storePath: cli.storePath,
      projectId: "delivery-stale-reply-test"
    });
    try {
      const result = await new CodexDeliveryService(runtime.context, {
        clientFactory: () => ({
          client: new CodexAppServerClient(transport)
        })
      }).deliverPending({
        agentName: "loki",
        waitForCompletionMs: 1000
      });

      expect(result).toMatchObject({
        attempted: 1,
        delivered: 1,
        failed: 0,
        pending: 0
      });
    } finally {
      runtime.close();
    }

    const thread = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-stale-reply-test",
      "thread",
      "show",
      threadId
    );

    expect(thread).toContain("パー(✋)");
    expect(thread).not.toContain("✊ グー");
  });

  it("acknowledges replyPolicy=none Codex deliveries without starting an app-server turn", async () => {
    const cli = createCliHarness(roots);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-no-reply-test",
      "init",
      "--store-only"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-no-reply-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    const ask = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-no-reply-test",
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "ask",
      "loki",
      "FYI only. No response required.",
      "--reply-policy",
      "none"
    );
    const threadId = extract("conversation", ask);

    const runtime = openCliRuntime({
      cwd: cli.root,
      storePath: cli.storePath,
      projectId: "delivery-no-reply-test"
    });
    try {
      const result = await new CodexDeliveryService(runtime.context, {
        clientFactory: () => {
          throw new Error("replyPolicy=none should not open a Codex app-server client.");
        }
      }).deliverPending({
        agentName: "loki",
        waitForCompletionMs: 1000
      });
      const attempts = runtime.projections().inbox.deliveryAttempts;
      const inboxItem = runtime
        .projections()
        .inbox.items.find((item) => item.body?.includes("FYI only"));

      expect(result).toMatchObject({
        attempted: 1,
        delivered: 1,
        failed: 0,
        pending: 0
      });
      expect(attempts).toEqual([
        expect.objectContaining({
          status: "delivered",
          outcome: "acknowledged"
        })
      ]);
      expect(inboxItem).toMatchObject({
        status: "read"
      });
    } finally {
      runtime.close();
    }

    const thread = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-no-reply-test",
      "thread",
      "show",
      threadId
    );

    expect(thread).toContain("FYI only. No response required.");
    expect(thread).not.toContain("acknowledged");
  });

  it("keeps replyPolicy=none thread replies visible in Codex inbox after acknowledgement", async () => {
    const cli = createCliHarness(roots);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-no-reply-thread-reply-test",
      "init",
      "--store-only"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-no-reply-thread-reply-test",
      "join",
      "musashi",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-no-reply-thread-reply-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    const ask = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-no-reply-thread-reply-test",
      "--as",
      "musashi",
      "--actor-runtime",
      "codex",
      "ask",
      "loki",
      "Please answer once."
    );
    const threadId = extract("conversation", ask);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-no-reply-thread-reply-test",
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "reply",
      threadId,
      "Visible reply from loki."
    );

    const runtime = openCliRuntime({
      cwd: cli.root,
      storePath: cli.storePath,
      projectId: "delivery-no-reply-thread-reply-test"
    });
    try {
      const result = await new CodexDeliveryService(runtime.context, {
        clientFactory: () => {
          throw new Error(
            "replyPolicy=none thread replies should not open a Codex app-server client."
          );
        }
      }).deliverPending({
        agentName: "musashi",
        waitForCompletionMs: 1000
      });
      const inboxItem = runtime
        .projections()
        .inbox.items.find((item) => item.body?.includes("Visible reply from loki."));

      expect(result).toMatchObject({
        attempted: 1,
        delivered: 1,
        failed: 0,
        pending: 0
      });
      expect(inboxItem).toMatchObject({
        status: "delivered",
        replyPolicy: "none"
      });
    } finally {
      runtime.close();
    }

    const inbox = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-no-reply-thread-reply-test",
      "inbox",
      "--as",
      "musashi"
    );

    expect(inbox).toContain("inbox: musashi (1)");
    expect(inbox).toContain("[delivered]");
    expect(inbox).toContain("Visible reply from loki.");
  });

  it("records a Codex reply to a system-originated ask without routing it to a fake agent", async () => {
    const cli = createCliHarness(roots);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-system-test",
      "init",
      "--store-only"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-system-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    const ask = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-system-test",
      "ask",
      "loki",
      "Reply exactly PONG"
    );
    const threadId = extract("conversation", ask);
    const transport = new RecordingTransport(
      {
        initialize: {},
        "thread/read": [
          {
            thread: {
              id: "thread_loki"
            }
          },
          {
            thread: {
              id: "thread_loki",
              turns: [
                {
                  id: "turn_1",
                  status: "completed",
                  items: [
                    {
                      id: "item_1",
                      type: "agentMessage",
                      turnId: "turn_1",
                      text: "PONG"
                    }
                  ]
                }
              ]
            }
          }
        ],
        "turn/start": {
          turn: {
            id: "turn_1",
            status: "inProgress"
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread_loki",
          turn: {
            id: "turn_1",
            status: "completed"
          }
        }
      }
    );

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      lifecycle: "daemon"
    });

    const runtime = openCliRuntime({
      cwd: cli.root,
      storePath: cli.storePath,
      projectId: "delivery-system-test"
    });
    try {
      const result = await new CodexDeliveryService(runtime.context, {
        clientFactory: () => ({
          client: new CodexAppServerClient(transport)
        })
      }).deliverPending({
        agentName: "loki",
        waitForCompletionMs: 1000
      });

      expect(result).toMatchObject({
        attempted: 1,
        delivered: 1,
        failed: 0,
        pending: 0
      });
    } finally {
      runtime.close();
    }

    const thread = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-system-test",
      "thread",
      "show",
      threadId
    );

    expect(thread).toContain("system -> loki: Reply exactly PONG");
    expect(thread).toContain("loki -> unrouted: PONG");
  });

  it("failed Codex app-server delivery leaves the message visible", async () => {
    const cli = createCliHarness(roots);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-failed-test",
      "init",
      "--store-only"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-failed-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-failed-test",
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "ask",
      "loki",
      "Reply exactly PONG"
    );

    writeCodexAppServerWorker(cli.root, {
      agentName: "loki",
      cwd: cli.root,
      serverUrl: "ws://127.0.0.1:48123",
      startedByTachikoma: true,
      codexThreadId: "thread_loki",
      lifecycle: "daemon"
    });

    const runtime = openCliRuntime({
      cwd: cli.root,
      storePath: cli.storePath,
      projectId: "delivery-failed-test"
    });
    try {
      const result = await new CodexDeliveryService(runtime.context, {
        clientFactory: () => {
          throw new Error("app-server unavailable");
        }
      }).deliverPending({
        agentName: "loki",
        waitForCompletionMs: 1000
      });

      expect(result).toMatchObject({
        attempted: 1,
        delivered: 0,
        failed: 1
      });
    } finally {
      runtime.close();
    }

    const inbox = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "delivery-failed-test",
      "inbox",
      "--as",
      "loki"
    );

    expect(inbox).toContain("[failed]");
    expect(inbox).toContain("Reply exactly PONG");
  });

  it("codex deliver --once reports an empty batch without requiring app-server", async () => {
    const cli = createCliHarness(roots);

    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "deliver-empty-test",
      "init",
      "--store-only"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "deliver-empty-test",
      "join",
      "loki",
      "--runtime",
      "codex",
      "--delivery-mode",
      "realtime"
    );

    const output = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "deliver-empty-test",
      "codex",
      "deliver",
      "--name",
      "loki",
      "--once"
    );

    expect(output).toContain("delivery: attempted=0 delivered=0 failed=0 pending=0");
  });

  it("probe command fails closed when app-server is unavailable and leaves inbox queued", async () => {
    const cli = createCliHarness(roots);

    await cli.run("--store", cli.storePath, "--project", "probe-test", "init", "--store-only");
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "probe-test",
      "join",
      "codex-impl",
      "--runtime",
      "codex",
      "--role",
      "implementer",
      "--delivery-mode",
      "turn"
    );
    await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "probe-test",
      "ask",
      "codex-impl",
      "queued before failed app-server probe"
    );

    const probe = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "probe-test",
      "codex-remote",
      "probe",
      "--cwd",
      cli.root,
      "--message",
      "Tachikoma delivered a failed probe.",
      "--proxy-command",
      process.execPath,
      "--proxy-arg",
      "-e",
      "--proxy-arg",
      "process.exit(2)",
      "--timeout-ms",
      "100"
    );
    const inbox = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "probe-test",
      "inbox",
      "--as",
      "codex-impl"
    );

    expect(probe).toContain("codex remote probe: unavailable");
    expect(probe).toContain("delivery: Tachikoma messages were not marked delivered");
    expect(inbox).toContain("[queued]");
    expect(inbox).toContain("queued before failed app-server probe");

    const aliasProbe = await cli.run(
      "--store",
      cli.storePath,
      "--project",
      "probe-test",
      "codex",
      "probe",
      "--cwd",
      cli.root,
      "--message",
      "Tachikoma delivered a failed probe.",
      "--proxy-command",
      process.execPath,
      "--proxy-arg",
      "-e",
      "--proxy-arg",
      "process.exit(2)",
      "--timeout-ms",
      "100"
    );

    expect(aliasProbe).toContain("codex remote probe: unavailable");
    expect(aliasProbe).toContain("delivery: Tachikoma messages were not marked delivered");
  });
});

interface RecordedRequest {
  method: string;
  params?: unknown;
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

type RecordedResponse = unknown | Error;

class RecordingTransport implements CodexJsonRpcTransport {
  public readonly requests: RecordedRequest[] = [];
  public readonly notifications: RecordedRequest[] = [];

  public constructor(
    private readonly responses: Record<string, RecordedResponse | RecordedResponse[]>,
    private readonly awaitedNotification?: CodexAppServerNotification
  ) {}

  public request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({
      method,
      params
    });

    if (!(method in this.responses)) {
      throw new Error(`Unexpected request: ${method}`);
    }

    const response = this.nextResponse(method);
    if (response instanceof Error) {
      throw response;
    }

    return Promise.resolve(response);
  }

  public notify(method: string, params?: unknown): void {
    this.notifications.push({
      method,
      params
    });
  }

  public waitForNotification(
    predicate: (notification: CodexAppServerNotification) => boolean
  ): Promise<CodexAppServerNotification> {
    if (!this.awaitedNotification || !predicate(this.awaitedNotification)) {
      throw new Error("Unexpected notification wait.");
    }

    return Promise.resolve(this.awaitedNotification);
  }

  private nextResponse(method: string): RecordedResponse {
    const response = this.responses[method];

    if (Array.isArray(response)) {
      const next = response.shift();
      if (next === undefined) {
        throw new Error(`No response left for request: ${method}`);
      }

      return next;
    }

    return response;
  }
}

interface CliHarness {
  root: string;
  storePath: string;
  run(...argv: string[]): Promise<string>;
}

function createCliHarness(roots: string[]): CliHarness {
  const root = mkdtempSync(join(tmpdir(), "tachikoma-codex-probe-"));
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

  roots.push(root);

  return {
    root,
    storePath,
    run: async (...argv: string[]) => {
      const outputStart = output.length;
      const errorStart = errors.length;

      await main(argv, {
        cwd: root,
        io
      });

      const errorOutput = errors.slice(errorStart).join("\n");
      if (errorOutput) {
        throw new Error(errorOutput);
      }

      return output.slice(outputStart).join("\n");
    }
  };
}
