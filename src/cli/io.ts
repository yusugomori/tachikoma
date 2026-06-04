import type { ConversationParticipant, LinkedRecord, RoutingTarget } from "../domain/types.js";

export interface CliIo {
  colors?: boolean;
  write(message: string): void;
  error(message: string): void;
}

export function createConsoleIo(): CliIo {
  const colors = shouldUseColor();

  return {
    colors,
    write: (message) => {
      console.log(message);
    },
    error: (message) => {
      console.error(message);
    }
  };
}

export function writeLines(io: CliIo, lines: string[]): void {
  for (const line of lines) {
    io.write(line);
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export type CliColor = "bold" | "green" | "cyan" | "yellow" | "red";

const colorCodes: Record<CliColor, string> = {
  bold: "1",
  green: "32",
  cyan: "36",
  yellow: "33",
  red: "31"
};

export function colorize(io: CliIo, color: CliColor, message: string): string {
  if (!io.colors) {
    return message;
  }

  return `\u001b[${colorCodes[color]}m${message}\u001b[0m`;
}

function shouldUseColor(): boolean {
  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== "0";
  }

  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  return process.stdout.isTTY === true;
}

export function formatTarget(target: RoutingTarget): string {
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

export function formatTargets(targets: RoutingTarget[]): string {
  if (targets.length === 0) {
    return "unrouted";
  }

  return targets.map(formatTarget).join(", ");
}

export function formatParticipant(participant: ConversationParticipant): string {
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

export function formatLinkedRecords(records: LinkedRecord[]): string {
  if (records.length === 0) {
    return "none";
  }

  return records.map((record) => `${record.kind}:${record.id}`).join(", ");
}

export function truncate(value: string | undefined, length = 100): string {
  if (!value) {
    return "";
  }

  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, length - 3)}...`;
}
