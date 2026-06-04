import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpRuntimeDefaults } from "./context.js";
import { openMcpRuntime } from "./context.js";
import { projectStateData, renderMemory, renderProjectState } from "./format.js";

export const memoryResourceUri = "tachikoma://memory";
export const projectStateResourceUri = "tachikoma://project-state";

export function registerTachikomaResources(server: McpServer, defaults: McpRuntimeDefaults): void {
  server.registerResource(
    "tachikoma-memory",
    memoryResourceUri,
    {
      title: "Tachikoma Memory",
      description: "Compact shared memory for the current Tachikoma project.",
      mimeType: "text/plain"
    },
    async (uri) => {
      const runtime = openMcpRuntime(defaults);

      try {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: renderMemory(runtime.projections())
            }
          ]
        };
      } finally {
        runtime.close();
      }
    }
  );

  server.registerResource(
    "tachikoma-project-state",
    projectStateResourceUri,
    {
      title: "Tachikoma Project State",
      description: "Synchronized project state rebuilt from Tachikoma projections.",
      mimeType: "application/json"
    },
    async (uri) => {
      const runtime = openMcpRuntime(defaults);

      try {
        const projections = runtime.projections();

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: renderProjectState(projections),
              _meta: {
                projectId: projections.projectState.project?.id,
                pendingInbox: projections.brief.pendingInboxCount,
                openConversations: projections.brief.openConversationCount,
                state: projectStateData(projections)
              }
            }
          ]
        };
      } finally {
        runtime.close();
      }
    }
  );
}
