import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ConversationParticipant, LinkedRecord, RoutingTarget } from "../domain/types.js";
import {
  getInboxForAgentName,
  liveSessionsForEndpoint,
  messagesForThread,
  openFindings,
  openThreads
} from "../projections/index.js";
import type { ServiceProjectionState } from "../services/index.js";

export interface ToolResponseOptions {
  title?: string;
}

export function toolResponse(data: unknown, options: ToolResponseOptions = {}): CallToolResult {
  const structuredContent = toJsonValue(data);

  return {
    content: [
      {
        type: "text",
        text: options.title
          ? `${options.title}\n${JSON.stringify(structuredContent, null, 2)}`
          : JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent: asStructuredContent(structuredContent)
  };
}

export function renderMemory(projections: ServiceProjectionState): string {
  return projections.brief.lines.join("\n");
}

export function renderProjectState(projections: ServiceProjectionState): string {
  return JSON.stringify(projectStateData(projections), null, 2);
}

export function projectStateData(projections: ServiceProjectionState): Record<string, unknown> {
  return {
    project: projections.projectState.project,
    agents: projections.agents,
    tasks: projections.tasks,
    claims: projections.claims,
    reviews: projections.reviews,
    verification: projections.verification,
    conversations: projections.conversations,
    inbox: projections.inbox,
    memory: projections.brief
  };
}

export function statusData(projections: ServiceProjectionState): Record<string, unknown> {
  const activeTask = projections.tasks.tasks.find(
    (task) => task.id === projections.tasks.activeTaskId
  );
  const pendingInbox = projections.inbox.items.filter(
    (item) => item.status !== "read" && item.status !== "cancelled"
  );

  return {
    project: projections.projectState.project,
    activeTask,
    agents: projections.agents.endpoints.map((endpoint) => ({
      ...endpoint,
      status: liveSessionsForEndpoint(projections.agents, endpoint).length > 0 ? "live" : "offline"
    })),
    assignments: projections.tasks.assignments,
    openConversations: openThreads(projections.conversations),
    pendingInbox,
    openFindings: openFindings(projections.reviews),
    verificationGaps: projections.verification.missingExpectations,
    memory: projections.brief.lines
  };
}

export function inboxData(
  projections: ServiceProjectionState,
  agentName?: string
): Record<string, unknown> {
  const items = agentName
    ? getInboxForAgentName(projections.inbox, projections.agents, agentName)
    : projections.inbox.items.filter(
        (item) => item.status !== "read" && item.status !== "cancelled"
      );

  return {
    agentName,
    count: items.length,
    items
  };
}

export function threadListData(projections: ServiceProjectionState): Record<string, unknown> {
  return {
    threads: projections.conversations.threads
  };
}

export function threadData(
  projections: ServiceProjectionState,
  conversationId: string
): Record<string, unknown> {
  const thread = projections.conversations.threads.find(
    (candidate) => candidate.id === conversationId
  );

  if (!thread) {
    throw new Error(`Thread not found: ${conversationId}`);
  }

  const messages = messagesForThread(projections.conversations, conversationId);
  const linkedRecords = [
    ...thread.linkedRecords,
    ...messages.flatMap((message) => message.linkedRecords)
  ];

  return {
    thread,
    messages,
    linked: {
      records: linkedRecords,
      assignments: projections.tasks.assignments.filter((assignment) =>
        linkedRecords.some((record) => record.kind === "assignment" && record.id === assignment.id)
      ),
      claims: projections.claims.claims.filter((claim) => claim.conversationId === conversationId),
      reviewRequests: projections.reviews.requests.filter(
        (request) => request.conversationId === conversationId
      ),
      reviewFindings: projections.reviews.findings.filter(
        (finding) => finding.conversationId === conversationId
      ),
      verification: projections.verification.results.filter(
        (result) => result.conversationId === conversationId
      )
    },
    text: renderThreadText(thread, messages)
  };
}

function renderThreadText(
  thread: { id: string; title: string; linkedRecords: LinkedRecord[] },
  messages: Array<{
    createdAt: string;
    sender: ConversationParticipant;
    recipients: RoutingTarget[];
    body: string;
    linkedRecords: LinkedRecord[];
  }>
): string {
  return [
    `thread: ${thread.id}`,
    `title: ${thread.title}`,
    `linked: ${formatLinkedRecords(thread.linkedRecords)}`,
    "messages:",
    ...messages.flatMap((message) => [
      `- ${message.createdAt} ${formatParticipant(message.sender)} -> ${message.recipients.map(formatTarget).join(", ")}: ${message.body}`,
      message.linkedRecords.length > 0
        ? `  linked: ${formatLinkedRecords(message.linkedRecords)}`
        : undefined
    ])
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatTarget(target: RoutingTarget): string {
  switch (target.kind) {
    case "agent":
      return target.name;
    case "role":
      return `role:${target.role}`;
    case "runtime-role":
      return `runtime-role:${target.runtime}:${target.role}`;
    case "session":
      return `session:${target.sessionId}`;
    case "broadcast":
      return `broadcast:${target.runtime ?? "*"}:${target.role ?? "*"}`;
  }
}

function formatParticipant(participant: ConversationParticipant): string {
  switch (participant.kind) {
    case "agent":
      return participant.name;
    case "user":
      return participant.name ?? "user";
    case "system":
      return participant.name ?? "system";
    case "role":
      return `role:${participant.role}`;
    case "runtime-role":
      return `runtime-role:${participant.runtime}:${participant.role}`;
    case "session":
      return participant.name ?? `session:${participant.sessionId}`;
  }
}

function formatLinkedRecords(records: LinkedRecord[]): string {
  if (records.length === 0) {
    return "none";
  }

  return records.map((record) => `${record.kind}:${record.id}`).join(", ");
}

function toJsonValue(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data ?? null)) as unknown;
}

function asStructuredContent(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {
    value
  };
}
