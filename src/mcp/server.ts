import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { McpRuntimeDefaults } from "./context.js";
import { mcpDefaultsFromArgv } from "./context.js";
import { registerTachikomaResources } from "./resources.js";
import { registerTachikomaTools } from "./tools.js";

export interface TachikomaMcpServerOptions extends McpRuntimeDefaults {
  name?: string;
  version?: string;
}

export function createTachikomaMcpServer(options: TachikomaMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? "tachikoma",
      version: options.version ?? "0.2.1"
    },
    {
      capabilities: {
        resources: {
          listChanged: true
        },
        tools: {
          listChanged: true
        }
      }
    }
  );

  registerTachikomaTools(server, options);
  registerTachikomaResources(server, options);

  return server;
}

export async function startStdioServer(
  options: TachikomaMcpServerOptions = {}
): Promise<McpServer> {
  const server = createTachikomaMcpServer(options);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdioServer(mcpDefaultsFromArgv()).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
