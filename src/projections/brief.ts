import { type AgentsProjectionState, liveSessionsForEndpoint } from "./agents.js";
import type { ClaimsProjectionState } from "./claims.js";
import { type ConversationsProjectionState, openThreads } from "./conversations.js";
import type { InboxProjectionState } from "./inbox.js";
import type { ProjectStateProjectionState } from "./project-state.js";
import { openFindings, type ReviewsProjectionState } from "./reviews.js";
import type { TasksProjectionState } from "./tasks.js";
import type { VerificationProjectionState } from "./verification.js";

export interface BriefProjectionInput {
  projectState: ProjectStateProjectionState;
  agents: AgentsProjectionState;
  inbox: InboxProjectionState;
  tasks: TasksProjectionState;
  claims: ClaimsProjectionState;
  reviews: ReviewsProjectionState;
  verification: VerificationProjectionState;
  conversations: ConversationsProjectionState;
}

export interface BriefProjectionState {
  projectName?: string;
  activeTaskTitle?: string;
  liveAgentCount: number;
  pendingInboxCount: number;
  openConversationCount: number;
  openFindingCount: number;
  recentClaimCount: number;
  verificationGapCount: number;
  lines: string[];
}

export function buildBriefProjectionState(input: BriefProjectionInput): BriefProjectionState {
  const activeTask = input.tasks.tasks.find((task) => task.id === input.tasks.activeTaskId);
  const liveSessionIds = new Set(
    input.agents.endpoints.flatMap((endpoint) =>
      liveSessionsForEndpoint(input.agents, endpoint).map((session) => session.id)
    )
  );
  const pendingInbox = input.inbox.items.filter(
    (item) => item.status !== "read" && item.status !== "cancelled"
  );
  const openConversationCount = openThreads(input.conversations).length;
  const openFindingCount = openFindings(input.reviews).length;

  const brief: BriefProjectionState = {
    projectName: input.projectState.project?.name,
    activeTaskTitle: activeTask?.title,
    liveAgentCount: liveSessionIds.size,
    pendingInboxCount: pendingInbox.length,
    openConversationCount,
    openFindingCount,
    recentClaimCount: input.claims.claims.length,
    verificationGapCount: input.verification.missingExpectations.length,
    lines: []
  };

  brief.lines = renderBriefLines(brief);

  return brief;
}

export function renderBriefLines(brief: BriefProjectionState): string[] {
  return [
    brief.projectName ? `Project: ${brief.projectName}` : "Project: uninitialized",
    brief.activeTaskTitle ? `Active task: ${brief.activeTaskTitle}` : "Active task: none",
    `Agents live: ${brief.liveAgentCount}`,
    `Pending inbox: ${brief.pendingInboxCount}`,
    `Open conversations: ${brief.openConversationCount}`,
    `Open review findings: ${brief.openFindingCount}`,
    `Verification gaps: ${brief.verificationGapCount}`
  ];
}
