import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AgentRole, AgentRuntime, DeliveryMode } from "../domain/types.js";
import { liveSessionsForEndpoint } from "../projections/index.js";
import type { McpContextInput, McpRuntime, McpRuntimeDefaults } from "./context.js";
import { withMcpRuntime } from "./context.js";
import { inboxData, statusData, threadData, threadListData, toolResponse } from "./format.js";

const agentRuntimeSchema = z.enum(["codex", "claude", "other"]);
const agentRoleSchema = z.string().trim().min(1);
const deliveryModeSchema = z.enum(["off", "turn", "monitor", "both", "realtime"]);
const replyPolicySchema = z.enum(["required", "optional", "none"]);
const taskStatusSchema = z.enum([
  "planned",
  "in_progress",
  "blocked",
  "review_pending",
  "changes_requested",
  "done"
]);
const assignmentStatusSchema = z.enum([
  "queued",
  "claimed",
  "in_progress",
  "blocked",
  "review_pending",
  "done",
  "cancelled"
]);
const verificationStatusSchema = z.enum(["passed", "failed", "skipped", "manual_pending"]);

const contextShape = {
  cwd: z.string().min(1).optional().describe("Target repository cwd."),
  store: z.string().min(1).optional().describe("SQLite store path."),
  dataRoot: z.string().min(1).optional().describe("Tachikoma local data root."),
  projectId: z.string().min(1).optional().describe("Tachikoma project id."),
  projectName: z.string().min(1).optional().describe("Tachikoma project display name."),
  actorName: z.string().min(1).optional().describe("Acting agent name."),
  actorRuntime: agentRuntimeSchema.optional().describe("Acting agent runtime."),
  actorRole: agentRoleSchema.optional().describe("Optional acting agent role or label."),
  actorSession: z.string().min(1).optional().describe("Acting session id.")
};

const stringList = z.array(z.string().min(1)).default([]);

type ContextInput = z.infer<ReturnType<typeof contextSchema>>;

export function registerTachikomaTools(server: McpServer, defaults: McpRuntimeDefaults): void {
  server.registerTool(
    "tachikoma_project_init",
    {
      title: "Initialize Tachikoma Project",
      description: "Initialize Tachikoma project state.",
      inputSchema: {
        ...contextShape,
        name: z.string().min(1),
        repoRoot: z.string().min(1).optional()
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const event = runtime.services.project.initialize({
          name: input.name,
          repoRoot: input.repoRoot ?? runtime.cwd
        });

        return toolResponse({
          eventId: event.id,
          projectId: event.projectId,
          storePath: runtime.storePath
        });
      })
  );

  server.registerTool(
    "tachikoma_agent_register",
    {
      title: "Register Agent",
      description: "Register or update a named Tachikoma agent endpoint.",
      inputSchema: {
        ...contextShape,
        name: z.string().min(1),
        runtime: agentRuntimeSchema,
        role: agentRoleSchema.optional().describe("Optional project-local routing label.")
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const event = runtime.services.agents.registerEndpoint({
          name: input.name,
          runtime: input.runtime,
          role: input.role
        });

        return toolResponse({
          eventId: event.id,
          agentId: event.target.agentId,
          name: input.name
        });
      })
  );

  server.registerTool(
    "tachikoma_session_join",
    {
      title: "Join Session",
      description: "Name the current running agent session and claim pending inbox work.",
      inputSchema: {
        ...contextShape,
        name: z.string().min(1).optional(),
        runtime: agentRuntimeSchema.optional(),
        role: agentRoleSchema.optional().describe("Optional project-local routing label."),
        deliveryMode: deliveryModeSchema.default("turn"),
        capabilities: stringList,
        takeover: z.boolean().default(false),
        force: z.boolean().default(false)
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const existingActorSession =
          input.name === undefined ? liveSessionForActorSession(runtime) : undefined;
        const inferredLiveSession =
          input.name === undefined && !existingActorSession && !runtime.context.actor.sessionId
            ? inferLiveSession(runtime, input.runtime ?? runtime.context.actor.runtime)
            : undefined;
        const liveSession = existingActorSession ?? inferredLiveSession;
        const name = input.name ?? runtime.context.actor.name ?? liveSession?.endpoint.name;

        if (!name) {
          throw new Error(
            "tachikoma_session_join requires an explicit name or launcher actor context. Start with `tachikoma claude` / `tachikoma codex`, pass actorName/actorSession, or pass name."
          );
        }

        if (!input.name && liveSession) {
          const claimed =
            input.deliveryMode === "off"
              ? []
              : runtime.services.delivery.claimForSession({
                  sessionId: liveSession.session.id
                });

          return toolResponse({
            agentId: liveSession.endpoint.id,
            name,
            sessionId: liveSession.session.id,
            endpointCreated: false,
            endpointUpdated: false,
            endedSessionIds: [],
            claimedCount: claimed.length,
            memory: runtime.projections().brief.lines,
            existingSession: true
          });
        }

        const result = runtime.services.sessions.join({
          name,
          runtime: input.runtime ?? runtime.context.actor.runtime,
          role: input.role ?? runtime.context.actor.role,
          deliveryMode: input.deliveryMode,
          cwd: runtime.cwd,
          capabilities: input.capabilities,
          takeover: input.takeover,
          force: input.force
        });
        const claimed =
          input.deliveryMode === "off"
            ? []
            : runtime.services.delivery.claimForSession({ sessionId: result.sessionId });

        return toolResponse({
          agentId: result.agentId,
          name,
          sessionId: result.sessionId,
          endpointCreated: result.endpointCreated,
          endpointUpdated: result.endpointUpdated,
          endedSessionIds: result.endedSessionIds,
          claimedCount: claimed.length,
          memory: runtime.projections().brief.lines
        });
      })
  );

  server.registerTool(
    "tachikoma_session_start",
    {
      title: "Start Session",
      description: "Start an agent session and claim queued work.",
      inputSchema: {
        ...contextShape,
        name: z.string().min(1).optional(),
        agentId: z.string().min(1).optional(),
        runtime: agentRuntimeSchema.optional(),
        role: agentRoleSchema.optional().describe("Optional project-local routing label."),
        deliveryMode: deliveryModeSchema.default("turn"),
        capabilities: stringList
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const events = runtime.services.sessions.start({
          name: input.name,
          agentId: input.agentId,
          runtime: input.runtime,
          role: input.role,
          deliveryMode: input.deliveryMode,
          cwd: runtime.cwd,
          capabilities: input.capabilities
        });
        const sessionId = events.find((event) => event.type === "session.started")?.target
          .sessionId;

        if (!sessionId) {
          throw new Error("session.start did not return a session id.");
        }

        const claimed = runtime.services.delivery.claimForSession({ sessionId });

        return toolResponse({
          sessionId,
          claimedCount: claimed.length,
          memory: runtime.projections().brief.lines
        });
      })
  );

  server.registerTool(
    "tachikoma_memory",
    {
      title: "Memory",
      description: "Return compact shared project memory.",
      inputSchema: contextShape
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) =>
        toolResponse({
          lines: runtime.projections().brief.lines
        })
      )
  );

  server.registerTool(
    "tachikoma_status",
    {
      title: "Status",
      description: "Return synchronized project state from projections.",
      inputSchema: contextShape
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) =>
        toolResponse(statusData(runtime.projections()))
      )
  );

  server.registerTool(
    "tachikoma_inbox",
    {
      title: "Inbox",
      description: "Return pending inbox items for a project or named endpoint.",
      inputSchema: {
        ...contextShape,
        agentName: z.string().min(1).optional()
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) =>
        toolResponse(inboxData(runtime.projections(), input.agentName))
      )
  );

  server.registerTool(
    "tachikoma_ask",
    {
      title: "Ask Agent",
      description: "Open a conversation thread and route the first message.",
      inputSchema: {
        ...contextShape,
        target: z.string().min(1),
        request: z.string().min(1),
        title: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        scope: z.string().min(1).optional(),
        replyPolicy: replyPolicySchema.optional()
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const events = runtime.services.conversations.ask({
          target: input.target,
          body: input.request,
          title: input.title,
          taskId: input.taskId,
          scope: input.scope,
          replyPolicy: input.replyPolicy
        });
        const conversationId = events.find((event) => event.type === "conversation.opened")?.target
          .conversationId;
        const messageId = events.find((event) => event.type === "message.sent")?.target.messageId;
        const assignmentId = events.find((event) => event.type === "assignment.created")?.target
          .assignmentId;

        return toolResponse({
          conversationId,
          messageId,
          assignmentId,
          target: input.target
        });
      })
  );

  server.registerTool(
    "tachikoma_reply",
    {
      title: "Reply",
      description: "Reply to an existing Tachikoma conversation thread.",
      inputSchema: {
        ...contextShape,
        conversationId: z.string().min(1),
        message: z.string().min(1),
        replyPolicy: replyPolicySchema.optional()
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const events = runtime.services.conversations.replyToThread({
          conversationId: input.conversationId,
          body: input.message,
          replyPolicy: input.replyPolicy
        });
        const sent = events.find((event) => event.type === "message.sent");
        const projected = runtime
          .projections()
          .conversations.messages.find((message) => message.id === sent?.target.messageId);

        return toolResponse({
          conversationId: input.conversationId,
          messageId: sent?.target.messageId,
          recipients: projected?.recipients ?? []
        });
      })
  );

  server.registerTool(
    "tachikoma_ack",
    {
      title: "Acknowledge Inbox Item",
      description: "Mark an inbox item handled without sending a conversation reply.",
      inputSchema: {
        ...contextShape,
        inboxItemId: z.string().min(1)
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const event = runtime.services.messages.markRead({
          inboxItemId: input.inboxItemId
        });

        return toolResponse({
          eventId: event.id,
          inboxItemId: input.inboxItemId,
          acknowledged: true
        });
      })
  );

  server.registerTool(
    "tachikoma_thread_list",
    {
      title: "List Threads",
      description: "List Tachikoma conversation threads.",
      inputSchema: contextShape
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) =>
        toolResponse(threadListData(runtime.projections()))
      )
  );

  server.registerTool(
    "tachikoma_thread_show",
    {
      title: "Show Thread",
      description: "Show a conversation exchange and linked structured records.",
      inputSchema: {
        ...contextShape,
        conversationId: z.string().min(1)
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) =>
        toolResponse(threadData(runtime.projections(), input.conversationId))
      )
  );

  registerTaskTools(server, defaults);
  registerClaimTools(server, defaults);
  registerReviewTools(server, defaults);
  registerVerificationTools(server, defaults);
  registerReportTools(server, defaults);
}

function registerTaskTools(server: McpServer, defaults: McpRuntimeDefaults): void {
  server.registerTool(
    "tachikoma_task_create",
    {
      description: "Create a task.",
      inputSchema: {
        ...contextShape,
        title: z.string().min(1),
        parentTaskId: z.string().min(1).optional(),
        status: taskStatusSchema.default("planned")
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const event = runtime.services.tasks.createTask({
          title: input.title,
          parentTaskId: input.parentTaskId,
          status: input.status
        });

        return toolResponse({
          taskId: event.target.taskId,
          eventId: event.id
        });
      })
  );

  server.registerTool(
    "tachikoma_task_status",
    {
      description: "Change task status.",
      inputSchema: {
        ...contextShape,
        taskId: z.string().min(1),
        status: taskStatusSchema
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const event = runtime.services.tasks.changeTaskStatus({
          taskId: input.taskId,
          status: input.status
        });

        return toolResponse({
          eventId: event.id,
          taskId: input.taskId,
          status: input.status
        });
      })
  );

  server.registerTool(
    "tachikoma_task_assign",
    {
      description: "Create an assignment.",
      inputSchema: {
        ...contextShape,
        target: z.string().min(1),
        scope: z.string().min(1),
        taskId: z.string().min(1).optional(),
        status: assignmentStatusSchema.default("queued")
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const event = runtime.services.tasks.createAssignment({
          target: input.target,
          scope: input.scope,
          taskId: input.taskId,
          status: input.status
        });

        return toolResponse({
          assignmentId: event.target.assignmentId,
          eventId: event.id
        });
      })
  );
}

function registerClaimTools(server: McpServer, defaults: McpRuntimeDefaults): void {
  server.registerTool(
    "tachikoma_claim_record",
    {
      description: "Record an implementation claim and optionally request review.",
      inputSchema: {
        ...contextShape,
        taskId: z.string().min(1).optional(),
        assignmentId: z.string().min(1).optional(),
        conversationId: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
        agentId: z.string().min(1).optional(),
        summary: z.string().min(1),
        files: stringList,
        addressedFindingIds: stringList,
        verificationExpectation: z.string().min(1).optional(),
        requestReview: z.boolean().default(false),
        reviewer: z.string().min(1).optional(),
        reviewScope: z.string().min(1).optional()
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const shouldRequestReview =
          input.requestReview || Boolean(input.reviewer) || Boolean(input.reviewScope);
        const events = runtime.services.implementation.recordClaim({
          taskId: input.taskId,
          assignmentId: input.assignmentId,
          conversationId: input.conversationId,
          sessionId: input.sessionId,
          agentId: input.agentId,
          summary: input.summary,
          files: input.files,
          addressedFindingIds: input.addressedFindingIds,
          verificationExpectation: input.verificationExpectation,
          requestReview: shouldRequestReview
            ? {
                reviewer: input.reviewer,
                scope: input.reviewScope
              }
            : false
        });
        const claim = events.find((event) => event.type === "implementation.claim_recorded");
        const review = events.find((event) => event.type === "review.requested");

        return toolResponse({
          claimId: claim?.target.implementationClaimId,
          reviewRequestId: review?.target.reviewRequestId,
          conversationId: claim?.target.conversationId ?? review?.target.conversationId,
          eventIds: events.map((event) => event.id)
        });
      })
  );
}

function registerReviewTools(server: McpServer, defaults: McpRuntimeDefaults): void {
  server.registerTool(
    "tachikoma_review_request",
    {
      description: "Request review from a target.",
      inputSchema: {
        ...contextShape,
        reviewer: z.string().min(1),
        scope: z.string().min(1),
        implementationClaimId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        conversationId: z.string().min(1).optional()
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const events = runtime.services.reviews.requestReview({
          reviewer: input.reviewer,
          scope: input.scope,
          implementationClaimId: input.implementationClaimId,
          taskId: input.taskId,
          conversationId: input.conversationId
        });
        const request = events.find((event) => event.type === "review.requested");

        return toolResponse({
          reviewRequestId: request?.target.reviewRequestId,
          conversationId: request?.target.conversationId,
          eventIds: events.map((event) => event.id)
        });
      })
  );

  server.registerTool(
    "tachikoma_review_finding",
    {
      description: "Record a review finding.",
      inputSchema: {
        ...contextShape,
        summary: z.string().min(1),
        reviewRequestId: z.string().min(1).optional(),
        conversationId: z.string().min(1).optional(),
        implementationClaimId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        assignee: z.string().min(1).optional()
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const events = runtime.services.reviews.recordFinding({
          reviewRequestId: input.reviewRequestId,
          conversationId: input.conversationId,
          implementationClaimId: input.implementationClaimId,
          taskId: input.taskId,
          summary: input.summary,
          assignee: input.assignee
        });
        const finding = events.find((event) => event.type === "review.finding_recorded");

        return toolResponse({
          reviewFindingId: finding?.target.reviewFindingId,
          conversationId: finding?.target.conversationId,
          eventIds: events.map((event) => event.id)
        });
      })
  );

  registerReviewLifecycleTool(server, defaults, "tachikoma_review_address", "addressFinding");
  registerReviewLifecycleTool(server, defaults, "tachikoma_review_accept", "acceptFinding");
  registerReviewLifecycleTool(server, defaults, "tachikoma_review_reopen", "reopenFinding");

  server.registerTool(
    "tachikoma_review_approve",
    {
      description: "Approve a review request.",
      inputSchema: {
        ...contextShape,
        reviewRequestId: z.string().min(1),
        conversationId: z.string().min(1).optional(),
        implementationClaimId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        summary: z.string().min(1).optional()
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const event = runtime.services.reviews.approveReview({
          reviewRequestId: input.reviewRequestId,
          conversationId: input.conversationId,
          implementationClaimId: input.implementationClaimId,
          taskId: input.taskId,
          summary: input.summary
        });

        return toolResponse({
          reviewRequestId: input.reviewRequestId,
          eventId: event.id
        });
      })
  );
}

function registerReviewLifecycleTool(
  server: McpServer,
  defaults: McpRuntimeDefaults,
  name: "tachikoma_review_address" | "tachikoma_review_accept" | "tachikoma_review_reopen",
  method: "addressFinding" | "acceptFinding" | "reopenFinding"
): void {
  server.registerTool(
    name,
    {
      description: `Run review lifecycle command ${method}.`,
      inputSchema: {
        ...contextShape,
        reviewFindingId: z.string().min(1),
        reviewRequestId: z.string().min(1).optional(),
        conversationId: z.string().min(1).optional(),
        implementationClaimId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        summary: z.string().min(1).optional(),
        reviewer: z.string().min(1).optional()
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const result = runtime.services.reviews[method]({
          reviewFindingId: input.reviewFindingId,
          reviewRequestId: input.reviewRequestId,
          conversationId: input.conversationId,
          implementationClaimId: input.implementationClaimId,
          taskId: input.taskId,
          summary: input.summary,
          reviewer: input.reviewer
        });
        const events = Array.isArray(result) ? result : [result];

        return toolResponse({
          reviewFindingId: input.reviewFindingId,
          eventIds: events.map((event) => event.id)
        });
      })
  );
}

function registerVerificationTools(server: McpServer, defaults: McpRuntimeDefaults): void {
  server.registerTool(
    "tachikoma_verification_record",
    {
      description: "Record a verification result.",
      inputSchema: {
        ...contextShape,
        status: verificationStatusSchema,
        summary: z.string().min(1),
        taskId: z.string().min(1).optional(),
        conversationId: z.string().min(1).optional(),
        implementationClaimId: z.string().min(1).optional(),
        reviewFindingId: z.string().min(1).optional(),
        command: z.string().min(1).optional(),
        notifyOnFailure: z.boolean().default(true)
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const events = runtime.services.verification.record({
          status: input.status,
          summary: input.summary,
          taskId: input.taskId,
          conversationId: input.conversationId,
          implementationClaimId: input.implementationClaimId,
          reviewFindingId: input.reviewFindingId,
          command: input.command,
          notifyOnFailure: input.notifyOnFailure
        });
        const record = events.find((event) => event.type === "verification.recorded");

        return toolResponse({
          verificationId: record?.target.verificationId,
          eventIds: events.map((event) => event.id)
        });
      })
  );
}

function registerReportTools(server: McpServer, defaults: McpRuntimeDefaults): void {
  server.registerTool(
    "tachikoma_report_export",
    {
      description: "Write a regenerated report and record the export event.",
      inputSchema: {
        ...contextShape,
        path: z.string().min(1),
        format: z.enum(["markdown", "json"]).default("markdown")
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const rendered = runtime.services.reports.render({
          format: input.format
        });
        const writtenPath = writeRuntimeFile(runtime.cwd, input.path, rendered.content);
        const event = runtime.services.reports.export({
          path: writtenPath.relativePath,
          format: rendered.format
        });

        return toolResponse({
          reportId: event.target.reportId,
          eventId: event.id,
          path: writtenPath.relativePath,
          format: rendered.format,
          content: rendered.content
        });
      })
  );

  server.registerTool(
    "tachikoma_handoff_generate",
    {
      description: "Write a regenerated handoff document and record the handoff event.",
      inputSchema: {
        ...contextShape,
        path: z.string().min(1),
        summary: z.string().min(1),
        taskId: z.string().min(1).optional()
      }
    },
    async (input) =>
      withMcpRuntime(defaults, contextInput(input), (runtime) => {
        const rendered = runtime.services.handoffs.render({
          taskId: input.taskId,
          summary: input.summary
        });
        const writtenPath = writeRuntimeFile(runtime.cwd, input.path, rendered.content);
        const event = runtime.services.handoffs.generate({
          taskId: input.taskId,
          summary: input.summary
        });

        return toolResponse({
          handoffId: event.target.handoffId,
          eventId: event.id,
          path: writtenPath.relativePath,
          format: rendered.format,
          content: rendered.content
        });
      })
  );
}

function contextSchema() {
  return z.object(contextShape);
}

function contextInput(input: ContextInput): McpContextInput {
  return {
    cwd: input.cwd,
    store: input.store,
    dataRoot: input.dataRoot,
    projectId: input.projectId,
    projectName: input.projectName,
    actorName: input.actorName,
    actorRuntime: input.actorRuntime as AgentRuntime | undefined,
    actorRole: input.actorRole as AgentRole | undefined,
    actorSession: input.actorSession
  };
}

function liveSessionForActorSession(runtime: McpRuntime) {
  const actor = runtime.context.actor;

  if (!actor.sessionId) {
    return undefined;
  }

  const projections = runtime.projections();
  const matches = projections.agents.endpoints
    .filter((endpoint) => !actor.runtime || endpoint.runtime === actor.runtime)
    .flatMap((endpoint) =>
      liveSessionsForEndpoint(projections.agents, endpoint)
        .filter((session) => session.id === actor.sessionId)
        .map((session) => ({
          endpoint,
          session
        }))
    );

  return matches.length === 1 ? matches[0] : undefined;
}

function inferLiveSession(runtime: McpRuntime, agentRuntime?: AgentRuntime) {
  if (!agentRuntime) {
    return undefined;
  }

  const projections = runtime.projections();
  const matches = projections.agents.endpoints
    .filter((endpoint) => endpoint.runtime === agentRuntime)
    .map((endpoint) => ({
      endpoint,
      liveSessions: liveSessionsForEndpoint(projections.agents, endpoint)
    }))
    .filter(({ liveSessions }) => liveSessions.length > 0);

  if (matches.length !== 1) {
    return undefined;
  }

  const match = matches[0];
  const session = match?.liveSessions.at(-1);

  return match && session
    ? {
        endpoint: match.endpoint,
        session
      }
    : undefined;
}

export type { AgentRole, AgentRuntime, DeliveryMode };

function writeRuntimeFile(cwd: string, path: string, content: string): { relativePath: string } {
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);

  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);

  return {
    relativePath: isAbsolute(path) ? absolutePath : relative(cwd, absolutePath)
  };
}
