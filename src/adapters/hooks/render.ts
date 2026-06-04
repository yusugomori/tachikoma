import { tachikomaCliInvocation } from "../../config/source-checkout.js";
import type { ConversationParticipant, LinkedRecord, RoutingTarget } from "../../domain/types.js";
import type { DeliveryBatch, DeliveryDirective, ServiceContext } from "../../services/index.js";
import type { HostHookInput, HostRuntime } from "./types.js";

export interface SessionStartRenderInput {
  sessionId: string;
  agentName?: string;
  runtime?: string;
  deliveryMode: string;
  claimedCount: number;
  briefLines: string[];
  monitorCommand?: string;
}

export interface MonitorDirectiveRenderInput {
  agentName?: string;
  runtime?: string;
  deliveryMode: string;
  command?: string;
}

export function renderSessionStart(input: SessionStartRenderInput): string {
  return [
    `Tachikoma session: ${input.sessionId}`,
    input.agentName ? `Agent: ${input.agentName}` : undefined,
    `Delivery mode: ${input.deliveryMode}`,
    `Claimed inbox: ${input.claimedCount}`,
    ...renderMonitorDirective({
      agentName: input.agentName,
      runtime: input.runtime,
      deliveryMode: input.deliveryMode,
      command: input.monitorCommand
    }),
    ...input.briefLines
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderMonitorDirective(input: MonitorDirectiveRenderInput): string[] {
  if (
    input.runtime !== "claude" ||
    !input.agentName ||
    (input.deliveryMode !== "monitor" && input.deliveryMode !== "both")
  ) {
    return [];
  }

  const command = input.command ?? `tachikoma hook monitor --name ${input.agentName} --watch`;

  return [
    "Tachikoma monitor",
    `- agent: ${input.agentName}`,
    `- command: ${command}`,
    "- expected: keep this command running; act once on each directive it prints.",
    "- fallback: if Claude Monitor is unavailable, say so and use tachikoma-sync or turn hooks instead."
  ];
}

export function renderDeliveryBatch(batch: DeliveryBatch): string {
  if (!batch.supported || batch.directives.length === 0) {
    return "";
  }

  return [
    `Tachikoma ${batch.surface} delivery (${batch.deliveryMode})`,
    `Session: ${batch.session.id}`,
    `Agent: ${batch.endpoint.name}`,
    "Required Tachikoma replies must be recorded with tachikoma_reply or `tachikoma reply`; a normal chat answer alone does not satisfy reply_policy: required.",
    "Quiet mode: do not narrate routine ack, relay progress, waiting state, or status checks.",
    "Only speak for a final user-visible result, an error, an ambiguity, a loop guard, or an explicit status/verbose request.",
    `Reply identity: --as ${batch.endpoint.name} --actor-runtime ${batch.endpoint.runtime} --actor-session ${batch.session.id}`,
    `Pending messages: ${batch.directives.length}`,
    ...batch.directives.flatMap(renderDirective)
  ].join("\n");
}

export function renderReceivePrompt(batch: DeliveryBatch): string {
  if (!batch.supported || batch.directives.length === 0) {
    return "";
  }

  return [
    `Tachikoma delivered ${batch.directives.length} message(s) for ${batch.endpoint.name}.`,
    "Read the items below and follow each reply_policy.",
    "Required Tachikoma replies must be recorded with tachikoma_reply or `tachikoma reply`; a normal chat answer alone does not satisfy reply_policy: required.",
    "Quiet mode: do not narrate routine ack, relay progress, waiting state, or status checks.",
    "Only speak for a final user-visible result, an error, an ambiguity, a loop guard, or an explicit status/verbose request.",
    `Reply identity: --as ${batch.endpoint.name} --actor-runtime ${batch.endpoint.runtime} --actor-session ${batch.session.id}`,
    ...batch.directives.flatMap(renderDirective)
  ].join("\n");
}

export function renderBootIdentityContext(batch: DeliveryBatch, cwd: string): string {
  if (batch.endpoint.runtime !== "claude") {
    return `Tachikoma launcher identity is already bound for this host session. Agent: ${batch.endpoint.name}; Runtime: ${batch.endpoint.runtime}; Session: ${batch.session.id}; Reply identity: --as ${batch.endpoint.name} --actor-runtime ${batch.endpoint.runtime} --actor-session ${batch.session.id}; do not call tachikoma_session_join, inspect env, or use fallback sample names.`;
  }

  const command = renderClaudeMonitorCommand(cwd, batch.endpoint.name);

  return [
    "Tachikoma launcher identity is already bound for this Claude host session.",
    `Agent: ${batch.endpoint.name}`,
    `Runtime: ${batch.endpoint.runtime}`,
    `Session: ${batch.session.id}`,
    `Reply identity: --as ${batch.endpoint.name} --actor-runtime ${batch.endpoint.runtime} --actor-session ${batch.session.id}`,
    "Do not call tachikoma_session_join, do not inspect env, do not run status/inbox first, and do not use fallback sample names.",
    "Start realtime delivery with the Claude Monitor tool as the first tool action.",
    "Use this exact Monitor input:",
    JSON.stringify(
      {
        description: `Tachikoma delivery for ${batch.endpoint.name}`,
        persistent: true,
        timeout_ms: 1000,
        command
      },
      null,
      2
    ),
    "After the Monitor starts, stop booting. Use Tachikoma tools only when a delivery directive arrives."
  ].join("\n");
}

export function renderUnboundIdentityContext(
  context: ServiceContext,
  host: Pick<HostHookInput, "runtime" | "sessionId">
): string {
  const candidates = liveRuntimeCandidates(context, host.runtime);
  const runtimeLabel = host.runtime === "codex" ? "Codex" : "Claude";
  const invocation = host.runtime === "codex" ? "$tachikoma" : "/tachikoma";
  const candidateSummary =
    candidates.length === 0
      ? "none"
      : candidates
          .map((candidate) => `${candidate.name} session=${candidate.sessionId}`)
          .join("; ");

  return [
    `Tachikoma launcher identity is not bound for this ${runtimeLabel} host session.`,
    host.sessionId ? `Host session: ${host.sessionId}` : undefined,
    `Live ${host.runtime} candidates: ${candidateSummary}`,
    "No Tachikoma actor identity was resolved; do not call tachikoma_session_join, do not send Tachikoma messages under a guessed identity, and do not choose among multiple live candidates.",
    `Use explicit ${invocation} <name> ... for a known agent, or open this host through tachikoma ${host.runtime} with the expected name.`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderDirective(directive: DeliveryDirective): string[] {
  const sender = directive.sender ? formatParticipant(directive.sender) : "unknown";
  const thread = directive.conversationId ?? "none";
  const body = truncate(directive.body, 500);
  const lines = [
    `- inbox ${directive.inboxItemId} [${directive.status}] reason=${directive.reason}`,
    `  thread: ${thread}`,
    `  message_id: ${directive.messageId ?? "none"}`,
    `  from: ${sender}`,
    `  target: ${formatTarget(directive.target)}`,
    `  reply_policy: ${directive.replyPolicy}`,
    `  message: ${body}`
  ];

  if (directive.linkedRecords.length > 0) {
    lines.push(`  linked: ${formatLinkedRecords(directive.linkedRecords)}`);
  }

  if (directive.replyPolicy === "none") {
    lines.push(`  ack: tachikoma ack ${directive.inboxItemId} or use tachikoma_ack`);
  } else if (directive.conversationId) {
    const replyLabel = directive.replyPolicy === "required" ? "required_reply" : "reply";
    lines.push(
      `  ${replyLabel}: tachikoma reply ${directive.conversationId} "<message>" or use tachikoma_reply`
    );
    if (directive.replyPolicy === "required") {
      lines.push(
        "  required_rule: do not answer only in chat; record the reply through Tachikoma."
      );
    }
  }

  return lines;
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

function truncate(value: string | undefined, length: number): string {
  if (!value) {
    return "";
  }

  if (value.length <= length) {
    return value;
  }

  return `${value.slice(0, length - 3)}...`;
}

function renderClaudeMonitorCommand(cwd: string, agentName: string): string {
  const cli = tachikomaCliInvocation(cwd);
  return formatShellCommand(cli.command, [
    ...cli.leadingArgs,
    "--cwd",
    cwd,
    "hook",
    "monitor",
    "--name",
    agentName,
    "--watch",
    "--poll-ms",
    "1000",
    "--max-items",
    "5"
  ]);
}

function liveRuntimeCandidates(
  context: ServiceContext,
  runtime: HostRuntime
): Array<{ name: string; sessionId: string }> {
  const agents = context.projections().agents;

  return agents.sessions
    .filter((session) => !session.endedAt)
    .flatMap((session) => {
      const endpoint = agents.endpoints.find(
        (candidate) => candidate.id === session.agentId && candidate.runtime === runtime
      );
      const hasPresence = agents.presence.some(
        (presence) => presence.agentId === session.agentId && presence.sessionId === session.id
      );

      return endpoint && hasPresence
        ? [
            {
              name: endpoint.name,
              sessionId: session.id
            }
          ]
        : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function formatShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
