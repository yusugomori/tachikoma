export type HostRuntime = "codex" | "claude";

export interface HostHookInput {
  runtime: HostRuntime;
  eventName: string;
  sessionId?: string;
  cwd?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  stopHookActive?: boolean;
  source?: string;
  raw?: unknown;
}

export type HostHookOutput =
  | {
      kind: "noop";
    }
  | {
      kind: "context";
      context: string;
    }
  | {
      kind: "continue";
      prompt: string;
    };
