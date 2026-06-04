import type { ConversationParticipant, LinkedRecord, RoutingTarget } from "../domain/types.js";
import {
  getInboxForAgentName,
  messagesForThread,
  openFindings,
  openThreads
} from "../projections/index.js";
import type { ProjectSnapshot } from "./json.js";

export interface HandoffMarkdownInput {
  snapshot: ProjectSnapshot;
  summary: string;
  taskId?: string;
}

export function renderProjectSnapshotMarkdown(snapshot: ProjectSnapshot): string {
  const projectName = snapshot.project?.name ?? "uninitialized";
  const pendingInbox = snapshot.inbox.items.filter(
    (item) => item.status !== "read" && item.status !== "cancelled"
  );
  const liveSessionIds = new Set(snapshot.agents.presence.map((presence) => presence.sessionId));

  return [
    `# Tachikoma Report: ${projectName}`,
    "",
    `Generated: ${snapshot.generatedAt}`,
    `Project id: ${snapshot.project?.id ?? "uninitialized"}`,
    `Events: ${snapshot.eventLog.count}`,
    `Last event: ${snapshot.eventLog.lastEventId ?? "none"}`,
    "",
    "## Memory",
    ...bulletLines(snapshot.memory.lines),
    "",
    "## Agents",
    ...bulletLines(
      snapshot.agents.endpoints.map((endpoint) => {
        const live = snapshot.agents.sessions.some(
          (session) => session.agentId === endpoint.id && liveSessionIds.has(session.id)
        );
        return `${endpoint.name} (${endpoint.id}) runtime=${endpoint.runtime} role=${endpoint.role ?? "none"} ${live ? "live" : "offline"}`;
      }),
      "No named agents."
    ),
    "",
    "## Tasks",
    ...bulletLines(
      snapshot.tasks.tasks.map((task) => `${task.title} (${task.id}) status=${task.status}`),
      "No tasks."
    ),
    "",
    "## Assignments",
    ...bulletLines(
      snapshot.tasks.assignments.map(
        (assignment) =>
          `${assignment.scope} (${assignment.id}) target=${formatTarget(assignment.target)} status=${assignment.status}`
      ),
      "No assignments."
    ),
    "",
    "## Conversations",
    ...conversationLines(snapshot),
    "",
    "## Implementation Claims",
    ...bulletLines(
      snapshot.claims.claims.map(
        (claim) =>
          `${claim.summary} (${claim.id}) files=${claim.files.length} expectation=${claim.verificationExpectation ?? "none"}`
      ),
      "No implementation claims."
    ),
    "",
    "## Reviews",
    ...bulletLines(
      [
        ...snapshot.reviews.requests.map(
          (request) =>
            `request ${request.id} target=${formatTarget(request.target)} scope=${request.scope}`
        ),
        ...snapshot.reviews.findings.map(
          (finding) => `finding ${finding.id} status=${finding.status} ${finding.summary}`
        )
      ],
      "No reviews."
    ),
    "",
    "## Verification",
    ...bulletLines(
      [
        ...snapshot.verification.results.map(
          (result) => `${result.status} ${result.summary} (${result.id})`
        ),
        ...snapshot.verification.missingExpectations.map(
          (missing) => `missing ${missing.expectation} for ${missing.implementationClaimId}`
        )
      ],
      "No verification results or gaps."
    ),
    "",
    "## Pending Inbox",
    ...bulletLines(
      pendingInbox.map(
        (item) =>
          `${item.status} ${item.reason} (${item.id}) target=${formatTarget(item.target)} source=${item.sourceEventId}`
      ),
      "No pending inbox items."
    ),
    "",
    "## Recent Event Ids",
    ...bulletLines(snapshot.eventLog.recentEventIds, "No events."),
    ""
  ].join("\n");
}

export function renderHandoffMarkdown(input: HandoffMarkdownInput): string {
  const { snapshot } = input;
  const activeTask = input.taskId
    ? snapshot.tasks.tasks.find((task) => task.id === input.taskId)
    : snapshot.tasks.tasks.find((task) => task.id === snapshot.tasks.activeTaskId);
  const relevantClaims = activeTask
    ? snapshot.claims.claims.filter((claim) => claim.taskId === activeTask.id)
    : snapshot.claims.claims;
  const relevantFindings = activeTask
    ? snapshot.reviews.findings.filter((finding) => finding.taskId === activeTask.id)
    : openFindings(snapshot.reviews);
  const agentInbox = snapshot.agents.endpoints.flatMap((endpoint) =>
    getInboxForAgentName(snapshot.inbox, snapshot.agents, endpoint.name).map(
      (item) => `${endpoint.name}: ${item.reason} (${item.id})`
    )
  );

  return [
    `# Tachikoma Handoff: ${snapshot.project?.name ?? "uninitialized"}`,
    "",
    `Generated: ${snapshot.generatedAt}`,
    `Summary: ${input.summary}`,
    `Last event: ${snapshot.eventLog.lastEventId ?? "none"}`,
    "",
    "## Current Task",
    activeTask
      ? `- ${activeTask.title} (${activeTask.id}) status=${activeTask.status}`
      : "- No active task.",
    "",
    "## Startup Memory",
    ...bulletLines(snapshot.memory.lines),
    "",
    "## Pending Agent Inbox",
    ...bulletLines(agentInbox, "No pending agent inbox items."),
    "",
    "## Claims",
    ...bulletLines(
      relevantClaims.map((claim) => `${claim.summary} (${claim.id})`),
      "No relevant claims."
    ),
    "",
    "## Open Findings",
    ...bulletLines(
      relevantFindings.map((finding) => `${finding.status} ${finding.summary} (${finding.id})`),
      "No relevant findings."
    ),
    "",
    "## Verification Gaps",
    ...bulletLines(
      snapshot.verification.missingExpectations.map(
        (missing) => `${missing.expectation} for ${missing.implementationClaimId}`
      ),
      "No verification gaps."
    ),
    ""
  ].join("\n");
}

function conversationLines(snapshot: ProjectSnapshot): string[] {
  const threads = openThreads(snapshot.conversations);

  if (threads.length === 0) {
    return ["- No open conversations."];
  }

  return threads.flatMap((thread) => {
    const messages = messagesForThread(snapshot.conversations, thread.id);
    const latest = messages[messages.length - 1];
    return [
      `- ${thread.title} (${thread.id}) status=${thread.status} linked=${formatLinkedRecords(thread.linkedRecords)}`,
      latest
        ? `  latest: ${formatParticipant(latest.sender)} -> ${latest.recipients.map(formatTarget).join(", ")}: ${latest.body}`
        : undefined
    ].filter((line): line is string => Boolean(line));
  });
}

function bulletLines(lines: string[], empty = "None."): string[] {
  if (lines.length === 0) {
    return [`- ${empty}`];
  }

  return lines.map((line) => `- ${line}`);
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
