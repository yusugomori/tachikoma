import type { z } from "zod";

import type {
  agentRoleSchema,
  agentRuntimeSchema,
  assignmentStatusSchema,
  conversationParticipantSchema,
  conversationStatusSchema,
  decisionStatusSchema,
  deliveryAttemptStatusSchema,
  deliveryModeSchema,
  deliveryOutcomeSchema,
  inboxItemStatusSchema,
  linkedRecordSchema,
  messageStatusSchema,
  replyPolicySchema,
  reviewFindingStatusSchema,
  routingTargetSchema,
  taskStatusSchema,
  verificationStatusSchema
} from "./schemas.js";

export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type DeliveryMode = z.infer<typeof deliveryModeSchema>;
export type RoutingTarget = z.infer<typeof routingTargetSchema>;
export type ConversationParticipant = z.infer<typeof conversationParticipantSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;
export type MessageStatus = z.infer<typeof messageStatusSchema>;
export type InboxItemStatus = z.infer<typeof inboxItemStatusSchema>;
export type DeliveryAttemptStatus = z.infer<typeof deliveryAttemptStatusSchema>;
export type DeliveryOutcome = z.infer<typeof deliveryOutcomeSchema>;
export type ReplyPolicy = z.infer<typeof replyPolicySchema>;
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;
export type ReviewFindingStatus = z.infer<typeof reviewFindingStatusSchema>;
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;
export type LinkedRecord = z.infer<typeof linkedRecordSchema>;

export interface Project {
  id: string;
  name: string;
  repoRoot?: string;
  createdAt: string;
}

export interface AgentEndpoint {
  id: string;
  projectId: string;
  name: string;
  runtime: AgentRuntime;
  role?: AgentRole;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  agentId: string;
  runtime: AgentRuntime;
  role?: AgentRole;
  deliveryMode: DeliveryMode;
  cwd?: string;
  startedAt: string;
  endedAt?: string;
}

export interface Presence {
  id: string;
  projectId: string;
  agentId: string;
  sessionId: string;
  deliveryMode: DeliveryMode;
  capabilities: string[];
  lastSeenAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  parentTaskId?: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Assignment {
  id: string;
  projectId: string;
  taskId?: string;
  target: RoutingTarget;
  status: AssignmentStatus;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  projectId: string;
  conversationId: string;
  sender: ConversationParticipant;
  recipients: RoutingTarget[];
  body: string;
  replyPolicy: ReplyPolicy;
  linkedRecords: LinkedRecord[];
  createdAt: string;
}

export interface ConversationThread {
  id: string;
  projectId: string;
  title: string;
  participants: ConversationParticipant[];
  linkedRecords: LinkedRecord[];
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface InboxItem {
  id: string;
  projectId: string;
  conversationId: string;
  messageId: string;
  target: RoutingTarget;
  status: InboxItemStatus;
  claimedBySessionId?: string;
  createdAt: string;
  updatedAt: string;
  readAt?: string;
}

export interface DeliveryAttempt {
  id: string;
  projectId: string;
  inboxItemId: string;
  messageId: string;
  target: RoutingTarget;
  deliveryMode: DeliveryMode;
  status: DeliveryAttemptStatus;
  attemptedAt: string;
  deliveredAt?: string;
  outcome?: DeliveryOutcome;
  error?: string;
}

export interface Decision {
  id: string;
  projectId: string;
  taskId?: string;
  summary: string;
  rationale: string;
  status: DecisionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeItem {
  id: string;
  projectId: string;
  taskId?: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
}

export interface ImplementationClaim {
  id: string;
  projectId: string;
  taskId?: string;
  assignmentId?: string;
  conversationId?: string;
  sessionId?: string;
  agentId?: string;
  summary: string;
  files: string[];
  addressedFindingIds: string[];
  verificationExpectation?: string;
  createdAt: string;
}

export interface ReviewRequest {
  id: string;
  projectId: string;
  taskId?: string;
  conversationId?: string;
  implementationClaimId?: string;
  target: RoutingTarget;
  scope: string;
  createdAt: string;
}

export interface ReviewFinding {
  id: string;
  projectId: string;
  reviewRequestId?: string;
  taskId?: string;
  conversationId?: string;
  implementationClaimId?: string;
  summary: string;
  status: ReviewFindingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationResult {
  id: string;
  projectId: string;
  taskId?: string;
  conversationId?: string;
  implementationClaimId?: string;
  reviewFindingId?: string;
  command?: string;
  status: VerificationStatus;
  summary: string;
  createdAt: string;
}

export interface Handoff {
  id: string;
  projectId: string;
  taskId?: string;
  summary: string;
  createdAt: string;
}

export interface Report {
  id: string;
  projectId: string;
  path: string;
  format: "markdown" | "json";
  createdAt: string;
}
