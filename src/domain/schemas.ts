import { z } from "zod";

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const agentRuntimeSchema = z.preprocess(
  (value) => (value === "claude-code" ? "claude" : value),
  z.enum(["codex", "claude", "other"])
);

export const agentRoleSchema = z.string().trim().min(1);

export const deliveryModeSchema = z.enum(["off", "turn", "monitor", "both", "realtime"]);

export const routingTargetKindSchema = z.enum([
  "agent",
  "role",
  "runtime-role",
  "session",
  "broadcast"
]);

export const conversationParticipantKindSchema = z.enum([
  "user",
  "system",
  "agent",
  "role",
  "runtime-role",
  "session"
]);

export const taskStatusSchema = z.enum([
  "planned",
  "in_progress",
  "blocked",
  "review_pending",
  "changes_requested",
  "done"
]);

export const assignmentStatusSchema = z.enum([
  "queued",
  "claimed",
  "in_progress",
  "blocked",
  "review_pending",
  "done",
  "cancelled"
]);

export const messageStatusSchema = z.enum(["queued", "delivered", "read", "failed"]);

export const inboxItemStatusSchema = z.enum([
  "queued",
  "claimed",
  "delivered",
  "read",
  "failed",
  "cancelled"
]);

export const deliveryAttemptStatusSchema = z.enum(["attempted", "delivered", "failed"]);

export const deliveryOutcomeSchema = z.enum([
  "replied",
  "acknowledged",
  "forwarded",
  "recorded_state"
]);

export const replyPolicySchema = z.enum(["required", "optional", "none"]);

export const conversationStatusSchema = z.enum(["open", "closed"]);

export const decisionStatusSchema = z.enum(["proposed", "accepted", "rejected", "superseded"]);

export const reviewFindingStatusSchema = z.enum(["open", "addressed", "accepted", "reopened"]);

export const verificationStatusSchema = z.enum(["passed", "failed", "skipped", "manual_pending"]);

export const routingTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("agent"),
      name: z.string().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("role"),
      role: agentRoleSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("runtime-role"),
      runtime: agentRuntimeSchema,
      role: agentRoleSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      sessionId: z.string().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("broadcast"),
      runtime: agentRuntimeSchema.optional(),
      role: agentRoleSchema.optional()
    })
    .strict()
]);

export const conversationParticipantSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user"),
      name: z.string().min(1).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("system"),
      name: z.string().min(1).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      name: z.string().min(1),
      agentId: z.string().min(1).optional(),
      runtime: agentRuntimeSchema.optional(),
      role: agentRoleSchema.optional(),
      sessionId: z.string().min(1).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("role"),
      role: agentRoleSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("runtime-role"),
      runtime: agentRuntimeSchema,
      role: agentRoleSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("session"),
      sessionId: z.string().min(1),
      name: z.string().min(1).optional(),
      runtime: agentRuntimeSchema.optional(),
      role: agentRoleSchema.optional()
    })
    .strict()
]);

export const linkedRecordSchema = z.object({
  kind: z.enum([
    "task",
    "assignment",
    "review_request",
    "review_finding",
    "implementation_claim",
    "verification_result",
    "decision"
  ]),
  id: z.string().min(1)
});
