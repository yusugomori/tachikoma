import { randomUUID } from "node:crypto";

export type IdPrefix =
  | "agent"
  | "assign"
  | "claim"
  | "conv"
  | "dec"
  | "delivery"
  | "evt"
  | "finding"
  | "handoff"
  | "inbox"
  | "kn"
  | "msg"
  | "presence"
  | "proj"
  | "report"
  | "request"
  | "review"
  | "sess"
  | "task"
  | "vr";

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function isPrefixedId(value: string, prefix: IdPrefix): boolean {
  return value.startsWith(`${prefix}_`) && value.length > prefix.length + 1;
}
