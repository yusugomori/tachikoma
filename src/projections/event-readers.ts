import { z } from "zod";

import type { EventEnvelope } from "../domain/events.js";
import {
  agentRoleSchema,
  agentRuntimeSchema,
  assignmentStatusSchema,
  conversationParticipantSchema,
  deliveryModeSchema,
  deliveryOutcomeSchema,
  linkedRecordSchema,
  replyPolicySchema,
  reviewFindingStatusSchema,
  routingTargetSchema,
  taskStatusSchema,
  verificationStatusSchema
} from "../domain/schemas.js";
import type {
  AgentRole,
  AgentRuntime,
  AssignmentStatus,
  ConversationParticipant,
  DeliveryMode,
  DeliveryOutcome,
  LinkedRecord,
  ReplyPolicy,
  ReviewFindingStatus,
  RoutingTarget,
  TaskStatus,
  VerificationStatus
} from "../domain/types.js";

const linkedRecordsSchema = z.array(linkedRecordSchema);
const stringArraySchema = z.array(z.string().min(1));

export function payloadRecord(event: EventEnvelope): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readStringArray(record: Record<string, unknown>, key: string): string[] {
  return parseOptional(stringArraySchema, record[key]) ?? [];
}

export function readAgentRuntime(value: unknown): AgentRuntime | undefined {
  return parseOptional(agentRuntimeSchema, value);
}

export function readAgentRole(value: unknown): AgentRole | undefined {
  return parseOptional(agentRoleSchema, value);
}

export function readAssignmentStatus(value: unknown): AssignmentStatus | undefined {
  return parseOptional(assignmentStatusSchema, value);
}

export function readTaskStatus(value: unknown): TaskStatus | undefined {
  return parseOptional(taskStatusSchema, value);
}

export function readReviewFindingStatus(value: unknown): ReviewFindingStatus | undefined {
  return parseOptional(reviewFindingStatusSchema, value);
}

export function readVerificationStatus(value: unknown): VerificationStatus | undefined {
  return parseOptional(verificationStatusSchema, value);
}

export function readDeliveryMode(value: unknown): DeliveryMode | undefined {
  return parseOptional(deliveryModeSchema, value);
}

export function readDeliveryOutcome(value: unknown): DeliveryOutcome | undefined {
  return parseOptional(deliveryOutcomeSchema, value);
}

export function readReplyPolicy(value: unknown): ReplyPolicy | undefined {
  return parseOptional(replyPolicySchema, value);
}

export function readRoutingTarget(value: unknown): RoutingTarget | undefined {
  return parseOptional(routingTargetSchema, value);
}

export function readRoutingTargets(record: Record<string, unknown>, key: string): RoutingTarget[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((target) => {
    const parsed = readRoutingTarget(target);
    return parsed ? [parsed] : [];
  });
}

export function readConversationParticipant(value: unknown): ConversationParticipant | undefined {
  return parseOptional(conversationParticipantSchema, value);
}

export function readLinkedRecords(record: Record<string, unknown>, key: string): LinkedRecord[] {
  return parseOptional(linkedRecordsSchema, record[key]) ?? [];
}

export function parseOptional<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
