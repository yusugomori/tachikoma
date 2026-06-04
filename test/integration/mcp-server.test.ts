import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { openCliRuntime } from "../../src/cli/runtime.js";
import { createTachikomaMcpServer, mcpDefaultsFromArgv } from "../../src/mcp/index.js";
import type { TachikomaMcpServerOptions } from "../../src/mcp/server.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("MCP server", () => {
  it("starts over transport and exposes core Tachikoma tools and resources", async () => {
    const harness = await createMcpHarness();

    try {
      const tools = await harness.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "tachikoma_project_init",
          "tachikoma_agent_register",
          "tachikoma_ask",
          "tachikoma_reply",
          "tachikoma_thread_show",
          "tachikoma_status"
        ])
      );

      await harness.call("tachikoma_project_init", {
        name: "MCP Test"
      });
      const rolelessAgent = await harness.call("tachikoma_agent_register", {
        name: "musashi",
        runtime: "claude"
      });
      expect(rolelessAgent.name).toBe("musashi");
      const rolelessSession = await harness.call("tachikoma_session_join", {
        name: "loki",
        runtime: "codex",
        deliveryMode: "off"
      });
      expect(rolelessSession.endpointCreated).toBe(true);
      expect(rolelessSession.claimedCount).toBe(0);
      await harness.call("tachikoma_agent_register", {
        name: "loki",
        runtime: "codex",
        role: "reviewer"
      });
      await harness.call("tachikoma_agent_register", {
        name: "musashi",
        runtime: "claude",
        role: "implementer"
      });

      const ask = await harness.call("tachikoma_ask", {
        actorName: "loki",
        actorRuntime: "codex",
        actorRole: "reviewer",
        target: "musashi",
        request: "fix open findings through MCP"
      });
      const conversationId = stringField(ask, "conversationId");

      const claudeInbox = await harness.call("tachikoma_inbox", {
        agentName: "musashi"
      });
      expect(JSON.stringify(claudeInbox)).toContain("fix open findings through MCP");

      const session = await harness.call("tachikoma_session_start", {
        name: "musashi"
      });
      expect(session.claimedCount).toBe(1);

      await harness.call("tachikoma_reply", {
        actorName: "musashi",
        actorRuntime: "claude",
        actorRole: "implementer",
        conversationId,
        message: "MCP reply from implementer"
      });

      const thread = await harness.call("tachikoma_thread_show", {
        conversationId
      });
      expect(JSON.stringify(thread)).toContain("fix open findings through MCP");
      expect(JSON.stringify(thread)).toContain("MCP reply from implementer");
      expect(JSON.stringify(thread)).toContain("assignment");

      const status = await harness.call("tachikoma_status", {});
      expect(JSON.stringify(status)).toContain("MCP Test");
      expect(JSON.stringify(status)).toContain("openConversations");

      const resources = await harness.client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining(["tachikoma://memory", "tachikoma://project-state"])
      );

      const memoryResource = await harness.client.readResource({
        uri: "tachikoma://memory"
      });
      const memoryTool = await harness.call("tachikoma_memory", {});
      expect(memoryResource.contents[0]).toMatchObject({
        text: (memoryTool.lines as string[]).join("\n")
      });
    } finally {
      await harness.close();
    }
  });

  it("validates MCP tool input schemas", async () => {
    const harness = await createMcpHarness();

    try {
      const result = await harness.client.callTool({
        name: "tachikoma_ask",
        arguments: {
          target: "musashi"
        }
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Input validation error");
    } finally {
      await harness.close();
    }
  });

  it("reports ended sessions with stale presence as offline in status and memory", async () => {
    const harness = await createMcpHarness();

    try {
      const joined = await harness.call("tachikoma_session_join", {
        name: "claude-01",
        runtime: "claude",
        deliveryMode: "both"
      });
      const runtime = openCliRuntime({
        cwd: harness.root,
        storePath: harness.storePath,
        projectId: "mcp-test"
      });

      try {
        runtime.services.sessions.end({
          sessionId: stringField(joined, "sessionId")
        });
      } finally {
        runtime.close();
      }

      const status = await harness.call("tachikoma_status", {});
      const agents = status.agents as Array<{ name: string; status: string }>;
      const memory = await harness.call("tachikoma_memory", {});

      expect(agents.find((agent) => agent.name === "claude-01")).toMatchObject({
        status: "offline"
      });
      expect(memory.lines).toContain("Agents live: 0");
    } finally {
      await harness.close();
    }
  });

  it("uses launcher environment as MCP actor defaults", async () => {
    const previousName = process.env.TACHIKOMA_AGENT_NAME;
    const previousRuntime = process.env.TACHIKOMA_RUNTIME;
    const previousRole = process.env.TACHIKOMA_ROLE;
    const previousSession = process.env.TACHIKOMA_SESSION_ID;

    process.env.TACHIKOMA_AGENT_NAME = "codex-01";
    process.env.TACHIKOMA_RUNTIME = "codex";
    process.env.TACHIKOMA_ROLE = "reviewer";
    process.env.TACHIKOMA_SESSION_ID = "sess_host_codex_01";

    try {
      expect(mcpDefaultsFromArgv([]).actor).toMatchObject({
        name: "codex-01",
        runtime: "codex",
        role: "reviewer",
        sessionId: "sess_host_codex_01"
      });
    } finally {
      restoreEnv("TACHIKOMA_AGENT_NAME", previousName);
      restoreEnv("TACHIKOMA_RUNTIME", previousRuntime);
      restoreEnv("TACHIKOMA_ROLE", previousRole);
      restoreEnv("TACHIKOMA_SESSION_ID", previousSession);
    }
  });

  it("joins with MCP actor name when session_join omits name", async () => {
    const harness = await createMcpHarness({
      actor: {
        name: "codex-01",
        runtime: "codex",
        role: "reviewer",
        sessionId: "sess_host_codex_01"
      }
    });

    try {
      const joined = await harness.call("tachikoma_session_join", {
        deliveryMode: "off"
      });

      expect(joined).toMatchObject({
        name: "codex-01",
        endpointCreated: true,
        claimedCount: 0
      });
    } finally {
      await harness.close();
    }
  });

  it("infers the current actor from an unambiguous live runtime session", async () => {
    const harness = await createMcpHarness();

    try {
      await harness.call("tachikoma_session_join", {
        name: "claude-01",
        runtime: "claude",
        deliveryMode: "both"
      });
      await harness.call("tachikoma_session_join", {
        name: "codex-01",
        runtime: "codex",
        deliveryMode: "realtime"
      });

      const existing = await harness.call("tachikoma_session_join", {
        runtime: "claude",
        deliveryMode: "both"
      });

      expect(existing).toMatchObject({
        name: "claude-01",
        endpointCreated: false,
        existingSession: true
      });

      const ask = await harness.call("tachikoma_ask", {
        actorRuntime: "claude",
        target: "codex-01",
        request: "ping from inferred claude session"
      });
      const thread = await harness.call("tachikoma_thread_show", {
        conversationId: stringField(ask, "conversationId")
      });

      expect(JSON.stringify(thread)).toContain("claude-01");
      expect(JSON.stringify(thread)).toContain("ping from inferred claude session");
    } finally {
      await harness.close();
    }
  });

  it("resolves the current actor from an exact actorSession when multiple live sessions exist", async () => {
    const harness = await createMcpHarness();

    try {
      const first = await harness.call("tachikoma_session_join", {
        name: "claude-01",
        runtime: "claude",
        deliveryMode: "both"
      });
      const second = await harness.call("tachikoma_session_join", {
        name: "claude-02",
        runtime: "claude",
        deliveryMode: "both"
      });
      await harness.call("tachikoma_session_join", {
        name: "codex-01",
        runtime: "codex",
        deliveryMode: "realtime"
      });

      const existing = await harness.call("tachikoma_session_join", {
        actorSession: stringField(second, "sessionId"),
        deliveryMode: "both"
      });

      expect(existing).toMatchObject({
        name: "claude-02",
        sessionId: stringField(second, "sessionId"),
        endpointCreated: false,
        existingSession: true
      });
      expect(existing.sessionId).not.toBe(stringField(first, "sessionId"));

      const ask = await harness.call("tachikoma_ask", {
        actorSession: stringField(second, "sessionId"),
        target: "codex-01",
        request: "ping from exact actor session"
      });
      const thread = await harness.call("tachikoma_thread_show", {
        conversationId: stringField(ask, "conversationId")
      });

      expect(JSON.stringify(thread)).toContain("claude-02");
      expect(JSON.stringify(thread)).toContain("ping from exact actor session");
    } finally {
      await harness.close();
    }
  });

  it("fails name-less session_join deterministically when live sessions are ambiguous", async () => {
    const harness = await createMcpHarness();

    try {
      await harness.call("tachikoma_session_join", {
        name: "claude-01",
        runtime: "claude",
        deliveryMode: "both"
      });
      await harness.call("tachikoma_session_join", {
        name: "claude-02",
        runtime: "claude",
        deliveryMode: "both"
      });

      await expect(
        harness.call("tachikoma_session_join", {
          runtime: "claude",
          deliveryMode: "both"
        })
      ).rejects.toThrow("requires an explicit name or launcher actor context");
    } finally {
      await harness.close();
    }
  });

  it("does not fall back to unambiguous runtime inference when actorSession is invalid", async () => {
    const harness = await createMcpHarness();

    try {
      await harness.call("tachikoma_session_join", {
        name: "claude-01",
        runtime: "claude",
        deliveryMode: "both"
      });

      await expect(
        harness.call("tachikoma_session_join", {
          actorSession: "sess_missing",
          runtime: "claude",
          deliveryMode: "both"
        })
      ).rejects.toThrow("requires an explicit name or launcher actor context");
    } finally {
      await harness.close();
    }
  });
});

interface McpHarness {
  root: string;
  storePath: string;
  client: Client;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function createMcpHarness(options: TachikomaMcpServerOptions = {}): Promise<McpHarness> {
  const root = mkdtempSync(join(tmpdir(), "tachikoma-mcp-"));
  tempRoots.push(root);
  const storePath = join(root, "state", "tachikoma.sqlite");
  const server = createTachikomaMcpServer({
    ...options,
    cwd: root,
    storePath,
    projectId: "mcp-test",
    projectName: "MCP Test"
  });
  const client = new Client(
    {
      name: "tachikoma-test-client",
      version: "1.0.0"
    },
    {
      capabilities: {}
    }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    root,
    storePath,
    client,
    call: async (name, args) => {
      const result = await client.callTool({
        name,
        arguments: args
      });

      if (result.isError) {
        throw new Error(JSON.stringify(result.content));
      }

      return (result.structuredContent ?? {}) as Record<string, unknown>;
    },
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key];

  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
  }

  return value;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
