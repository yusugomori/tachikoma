import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { claudeMcpAddCommand, codexMcpAddCommand } from "../../src/adapters/index.js";
import { createTachikomaMcpServer } from "../../src/mcp/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("dogfooding MCP setup", () => {
  it("renders Codex and Claude registration commands for the built Tachikoma MCP server", () => {
    const repoRoot = "/tmp/tachikoma repo";

    const codex = codexMcpAddCommand({ repoRoot });
    const claude = claudeMcpAddCommand({ repoRoot });

    expect(codex.command).toBe("codex");
    expect(codex.args).toEqual([
      "mcp",
      "add",
      "--env",
      `TACHIKOMA_CWD=${repoRoot}`,
      "tachikoma",
      "--",
      "node",
      `${repoRoot}/dist/src/cli/index.js`,
      "mcp"
    ]);
    expect(codex.display).toContain("codex mcp add");
    expect(codex.display).toContain("'TACHIKOMA_CWD=/tmp/tachikoma repo'");

    expect(claude.command).toBe("claude");
    expect(claude.args).toEqual([
      "mcp",
      "add",
      "tachikoma",
      "--scope",
      "local",
      "-e",
      `TACHIKOMA_CWD=${repoRoot}`,
      "--",
      "node",
      `${repoRoot}/dist/src/cli/index.js`,
      "mcp"
    ]);
    expect(claude.display).toContain("claude mcp add tachikoma");
    expect(claude.display).toContain("'TACHIKOMA_CWD=/tmp/tachikoma repo'");
  });

  it("renders source-checkout registration commands through the pnpm tachikoma script", () => {
    const repoRoot = "/tmp/tachikoma repo";

    const codex = codexMcpAddCommand({ repoRoot, sourceCheckout: true });
    const claude = claudeMcpAddCommand({ repoRoot, sourceCheckout: true });

    expect(codex.args).toEqual([
      "mcp",
      "add",
      "--env",
      `TACHIKOMA_CWD=${repoRoot}`,
      "tachikoma",
      "--",
      "pnpm",
      "--dir",
      repoRoot,
      "tachikoma",
      "mcp"
    ]);
    expect(codex.display).toContain("pnpm --dir '/tmp/tachikoma repo' tachikoma mcp");

    expect(claude.args).toEqual([
      "mcp",
      "add",
      "tachikoma",
      "--scope",
      "local",
      "-e",
      `TACHIKOMA_CWD=${repoRoot}`,
      "--",
      "pnpm",
      "--dir",
      repoRoot,
      "tachikoma",
      "mcp"
    ]);
    expect(claude.display).toContain("pnpm --dir '/tmp/tachikoma repo' tachikoma mcp");
  });

  it("exposes session join and report tools through MCP", async () => {
    const root = mkdtempSync(join(tmpdir(), "tachikoma-mcp-dogfood-"));
    tempRoots.push(root);
    const storePath = join(root, "state", "tachikoma.sqlite");
    const server = createTachikomaMcpServer({
      cwd: root,
      storePath,
      projectId: "mcp-dogfood",
      projectName: "MCP Dogfood"
    });
    const client = new Client(
      {
        name: "tachikoma-dogfood-test",
        version: "1.0.0"
      },
      {
        capabilities: {}
      }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "tachikoma_session_join",
          "tachikoma_report_export",
          "tachikoma_handoff_generate"
        ])
      );

      const join = await client.callTool({
        name: "tachikoma_session_join",
        arguments: {
          name: "musashi",
          runtime: "claude",
          role: "implementer"
        }
      });

      expect(join.isError).toBeFalsy();
      expect(join.structuredContent).toMatchObject({
        endpointCreated: true,
        claimedCount: 0
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
