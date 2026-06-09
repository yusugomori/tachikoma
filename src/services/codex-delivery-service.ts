import { z } from "zod";

import {
  CodexAppServerClient,
  type CodexThreadSummary,
  WebSocketCodexAppServerTransport
} from "../adapters/codex/app-server-client.js";
import { isProcessAlive } from "../adapters/codex/app-server-process.js";
import {
  type CodexAppServerWorker,
  readCodexAppServerWorkers,
  writeCodexAppServerWorker
} from "../adapters/codex/app-server-state.js";
import type { EventEnvelope } from "../domain/events.js";
import type { AgentEndpoint, DeliveryMode } from "../domain/types.js";
import type { ServiceContext } from "./context.js";
import type { DeliveryDirective } from "./delivery-service.js";
import { DeliveryService } from "./delivery-service.js";
import { MessageService } from "./message-service.js";
import { parseCommandInput } from "./validation.js";

const codexDeliverPendingInputSchema = z.object({
  agentName: z.string().min(1),
  maxItems: z.number().int().positive().default(5),
  requestTimeoutMs: z.number().int().positive().default(15000)
});

export type CodexDeliverPendingInput = z.input<typeof codexDeliverPendingInputSchema>;

export interface CodexDeliveryClientHandle {
  client: CodexAppServerClient;
  close?(): Promise<void> | void;
}

export type CodexDeliveryClientFactory = (
  worker: CodexAppServerWorker,
  options: { requestTimeoutMs: number }
) => CodexDeliveryClientHandle;

export interface CodexDeliveryResult {
  agentName: string;
  supported: boolean;
  skippedReason?: string;
  attempted: number;
  delivered: number;
  failed: number;
  pending: number;
  warnings: string[];
  events: EventEnvelope[];
}

interface DeliverOneInput {
  client: CodexAppServerClient;
  threadId: string;
  cwd: string;
  endpoint: AgentEndpoint;
  deliveryMode: DeliveryMode;
  directive: DeliveryDirective;
}

export class CodexDeliveryService {
  private readonly delivery: DeliveryService;
  private readonly messages: MessageService;
  private readonly clientFactory: CodexDeliveryClientFactory;

  public constructor(
    private readonly context: ServiceContext,
    options: { clientFactory?: CodexDeliveryClientFactory } = {}
  ) {
    this.delivery = new DeliveryService(context);
    this.messages = new MessageService(context);
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  public async deliverPending(input: CodexDeliverPendingInput): Promise<CodexDeliveryResult> {
    const parsed = parseCommandInput(codexDeliverPendingInputSchema, input);
    const batch = this.delivery.collectPending({
      agentName: parsed.agentName,
      surface: "app-server"
    });
    const result = initialResult(parsed.agentName, batch.supported, batch.skippedReason);

    if (!batch.supported) {
      return result;
    }

    const directives = batch.directives.slice(0, parsed.maxItems);
    result.pending = batch.directives.length;

    if (directives.length === 0) {
      return result;
    }

    const actionableDirectives = directives.filter((directive) => directive.replyPolicy !== "none");
    for (const directive of directives.filter((candidate) => candidate.replyPolicy === "none")) {
      const outcome = this.acknowledgeOne(batch.deliveryMode, directive, {
        markRead: !this.isThreadReply(directive)
      });
      result.attempted += outcome.attempted;
      result.delivered += outcome.delivered;
      result.failed += outcome.failed;
      result.events.push(...outcome.events);
      result.warnings.push(...outcome.warnings);
    }

    if (actionableDirectives.length === 0) {
      result.pending = this.countRemainingPending(parsed.agentName);
      return result;
    }

    const worker = this.findWorker(parsed.agentName);
    if (!worker) {
      return this.failAll(
        result,
        batch.deliveryMode,
        actionableDirectives,
        "No Codex app-server worker state found."
      );
    }

    if (worker.pid && !isProcessAlive(worker.pid)) {
      return this.failAll(
        result,
        batch.deliveryMode,
        actionableDirectives,
        `Codex app-server pid ${worker.pid} is not alive.`
      );
    }

    let handle: CodexDeliveryClientHandle | undefined;
    try {
      handle = this.clientFactory(worker, {
        requestTimeoutMs: parsed.requestTimeoutMs
      });

      await handle.client.initialize();
      const deliveryThread = await this.resolveDeliveryThread(handle.client, worker);
      if (!deliveryThread) {
        result.warnings.push(
          `Codex TUI delivery is waiting for a loaded TUI thread for ${worker.agentName}. Open it with \`tachikoma codex --name ${worker.agentName}\` or \`tachikoma codex attach --name ${worker.agentName}\`.`
        );
        return result;
      }

      const activeWorker = writeCodexAppServerWorker(this.repoRoot(), {
        ...worker,
        codexThreadId: deliveryThread.id,
        lifecycle: worker.lifecycle
      });

      const deliveryThreadId = activeWorker.codexThreadId ?? deliveryThread.id;
      const directive = actionableDirectives[0];

      // Wake-only deliveries are no longer gated by a completion scrape, so we
      // serialize them here: deliver at most one actionable directive per cycle,
      // and never while Codex is mid-turn. Otherwise each pending item would fire
      // its own turn/start on the same thread and stack competing "current task"
      // turns. Remaining items stay pending and are delivered on a later cycle
      // once Codex is idle again.
      if (directive && !(await this.hasActiveTurn(handle.client, deliveryThreadId))) {
        const outcome = await this.deliverOne({
          client: handle.client,
          threadId: deliveryThreadId,
          cwd: deliveryThread.cwd ?? this.repoRoot(),
          endpoint: batch.endpoint,
          deliveryMode: batch.deliveryMode,
          directive
        });

        result.attempted += outcome.attempted;
        result.delivered += outcome.delivered;
        result.failed += outcome.failed;
        result.events.push(...outcome.events);
        result.warnings.push(...outcome.warnings);

        if (outcome.lastTurnId) {
          writeCodexAppServerWorker(this.repoRoot(), {
            ...activeWorker,
            lastTurnId: outcome.lastTurnId,
            lifecycle: activeWorker.lifecycle
          });
        }
      } else if (directive) {
        result.warnings.push(
          `Codex ${worker.agentName} is mid-turn; deferring ${actionableDirectives.length} pending task(s) until it is idle.`
        );
      }
    } catch (error) {
      await this.failAllInto(
        result,
        batch.deliveryMode,
        actionableDirectives,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      await handle?.close?.();
    }

    result.pending = this.countRemainingPending(parsed.agentName);
    return result;
  }

  private acknowledgeOne(
    deliveryMode: DeliveryMode,
    directive: DeliveryDirective,
    options: { markRead: boolean }
  ): {
    attempted: number;
    delivered: number;
    failed: number;
    events: EventEnvelope[];
    warnings: string[];
  } {
    const events: EventEnvelope[] = [];

    if (!directive.messageId) {
      return {
        attempted: 0,
        delivered: 0,
        failed: 0,
        events,
        warnings: [`Skipped inbox item ${directive.inboxItemId}: missing message id.`]
      };
    }

    const attemptId = this.context.id("delivery");
    events.push(
      this.messages.recordDeliveryAttempt({
        id: attemptId,
        inboxItemId: directive.inboxItemId,
        messageId: directive.messageId,
        recipient: directive.target,
        deliveryMode
      }),
      this.messages.recordDeliveryDelivered({
        id: attemptId,
        inboxItemId: directive.inboxItemId,
        messageId: directive.messageId,
        recipient: directive.target,
        deliveryMode,
        outcome: "acknowledged"
      })
    );

    if (options.markRead) {
      events.push(
        this.messages.markRead({
          inboxItemId: directive.inboxItemId
        })
      );
    }

    return {
      attempted: 1,
      delivered: 1,
      failed: 0,
      events,
      warnings: []
    };
  }

  private async resolveDeliveryThread(
    client: CodexAppServerClient,
    worker: CodexAppServerWorker
  ): Promise<CodexThreadSummary | undefined> {
    if (worker.lifecycle === "foreground") {
      return await client.findLoadedThread(this.repoRoot());
    }

    return (await client.ensureManagedThread(this.repoRoot(), worker.codexThreadId)).thread;
  }

  private async deliverOne(input: DeliverOneInput): Promise<{
    attempted: number;
    delivered: number;
    failed: number;
    events: EventEnvelope[];
    warnings: string[];
    lastTurnId?: string;
  }> {
    const events: EventEnvelope[] = [];
    const warnings: string[] = [];

    if (!input.directive.messageId || !input.directive.conversationId) {
      warnings.push(
        `Skipped inbox item ${input.directive.inboxItemId}: missing message or thread id.`
      );
      return {
        attempted: 0,
        delivered: 0,
        failed: 0,
        events,
        warnings
      };
    }

    const attemptId = this.context.id("delivery");
    events.push(
      this.messages.recordDeliveryAttempt({
        id: attemptId,
        inboxItemId: input.directive.inboxItemId,
        messageId: input.directive.messageId,
        recipient: input.directive.target,
        deliveryMode: input.deliveryMode
      })
    );

    try {
      const turn = await input.client.startTurn({
        threadId: input.threadId,
        cwd: input.cwd,
        message: formatDirectivePrompt(input.directive, input.endpoint.name)
      });

      if (!turn.id) {
        return this.failOne(input, attemptId, events, "turn/start did not return a turn id.");
      }

      // Wake-only delivery: the directive is now the agent's active task. The
      // started turn is intentionally NOT scraped — the agent records its own
      // outcome by calling tachikoma_reply when the work is complete (which may
      // be many turns later). Mark the inbox item handled so the delivery loop
      // does not re-inject the same task while the agent is still working.
      events.push(
        this.messages.recordDeliveryDelivered({
          id: attemptId,
          inboxItemId: input.directive.inboxItemId,
          messageId: input.directive.messageId,
          recipient: input.directive.target,
          deliveryMode: input.deliveryMode,
          outcome: "forwarded"
        }),
        this.messages.markRead({
          inboxItemId: input.directive.inboxItemId
        })
      );

      return {
        attempted: 1,
        delivered: 1,
        failed: 0,
        events,
        warnings,
        lastTurnId: turn.id
      };
    } catch (error) {
      return this.failOne(
        input,
        attemptId,
        events,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private failOne(
    input: DeliverOneInput,
    attemptId: string,
    events: EventEnvelope[],
    error: string,
    warnings: string[] = []
  ): {
    attempted: number;
    delivered: number;
    failed: number;
    events: EventEnvelope[];
    warnings: string[];
  } {
    events.push(
      this.messages.recordDeliveryFailed({
        id: attemptId,
        inboxItemId: input.directive.inboxItemId,
        messageId: input.directive.messageId ?? "unknown",
        recipient: input.directive.target,
        deliveryMode: input.deliveryMode,
        error
      })
    );

    return {
      attempted: 1,
      delivered: 0,
      failed: 1,
      events,
      warnings: uniqueStrings([...warnings, error])
    };
  }

  private async hasActiveTurn(client: CodexAppServerClient, threadId: string): Promise<boolean> {
    try {
      const thread = await client.readThreadNormalized(threadId);
      return thread.turns.some((turn) => isActiveTurnStatus(turn.status));
    } catch {
      // If the thread cannot be read we cannot prove Codex is busy; let the
      // single delivery attempt proceed and surface any real error itself.
      return false;
    }
  }

  private failAll(
    result: CodexDeliveryResult,
    deliveryMode: DeliveryMode,
    directives: DeliveryDirective[],
    error: string
  ): CodexDeliveryResult {
    this.failAllInto(result, deliveryMode, directives, error);
    return result;
  }

  private async failAllInto(
    result: CodexDeliveryResult,
    deliveryMode: DeliveryMode,
    directives: DeliveryDirective[],
    error: string
  ): Promise<void> {
    for (const directive of directives) {
      if (!directive.messageId) {
        continue;
      }

      const attemptId = this.context.id("delivery");
      result.events.push(
        this.messages.recordDeliveryAttempt({
          id: attemptId,
          inboxItemId: directive.inboxItemId,
          messageId: directive.messageId,
          recipient: directive.target,
          deliveryMode
        }),
        this.messages.recordDeliveryFailed({
          id: attemptId,
          inboxItemId: directive.inboxItemId,
          messageId: directive.messageId,
          recipient: directive.target,
          deliveryMode,
          error
        })
      );
      result.attempted += 1;
      result.failed += 1;
    }

    result.warnings.push(error);
  }

  private findWorker(agentName: string): CodexAppServerWorker | undefined {
    return readCodexAppServerWorkers(this.repoRoot()).find(
      (worker) => worker.agentName === agentName && worker.cwd === this.repoRoot()
    );
  }

  private countRemainingPending(agentName: string): number {
    return this.delivery.collectPending({
      agentName,
      surface: "app-server"
    }).directives.length;
  }

  private isThreadReply(directive: DeliveryDirective): boolean {
    if (!directive.conversationId || !directive.messageId) {
      return false;
    }

    const messages = this.context
      .projections()
      .conversations.messages.filter(
        (message) => message.conversationId === directive.conversationId
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    return messages.some((message, index) => message.id === directive.messageId && index > 0);
  }

  private repoRoot(): string {
    return this.context.project.repoRoot ?? process.cwd();
  }
}

function defaultClientFactory(
  worker: CodexAppServerWorker,
  options: { requestTimeoutMs: number }
): CodexDeliveryClientHandle {
  const transport = new WebSocketCodexAppServerTransport({
    url: worker.serverUrl,
    requestTimeoutMs: options.requestTimeoutMs
  });

  return {
    client: new CodexAppServerClient(transport),
    close: () => transport.close()
  };
}

function initialResult(
  agentName: string,
  supported: boolean,
  skippedReason: string | undefined
): CodexDeliveryResult {
  return {
    agentName,
    supported,
    skippedReason,
    attempted: 0,
    delivered: 0,
    failed: 0,
    pending: 0,
    warnings: [],
    events: []
  };
}

const ACTIVE_TURN_STATUSES = new Set([
  "inprogress",
  "in_progress",
  "running",
  "pending",
  "queued",
  "started",
  "active",
  "working"
]);

function isActiveTurnStatus(status: string | undefined): boolean {
  return status !== undefined && ACTIVE_TURN_STATUSES.has(status.toLowerCase());
}

function formatDirectivePrompt(directive: DeliveryDirective, agentName: string): string {
  const linkedRecords =
    directive.linkedRecords.length > 0
      ? directive.linkedRecords.map((record) => `${record.kind}:${record.id}`).join(", ")
      : "none";

  const conversationId = directive.conversationId ?? "unknown";

  return [
    `Tachikoma delivery for ${agentName}.`,
    `Thread: ${conversationId}`,
    `Message: ${directive.messageId ?? "unknown"}`,
    `Inbox item: ${directive.inboxItemId}`,
    `Reason: ${directive.reason}`,
    `Reply policy: ${directive.replyPolicy}`,
    `Linked records: ${linkedRecords}`,
    "",
    "This is assigned work delivered through Tachikoma. Treat it as your current task and start now; take as many turns as you need to finish it.",
    "",
    "Request:",
    directive.body ?? "(no body)",
    "",
    directive.replyPolicy === "required"
      ? `When the work is complete, report the result back to this Tachikoma thread by calling the \`tachikoma_reply\` tool (or \`tachikoma reply ${conversationId} "<message>"\` if MCP is unavailable) with conversationId "${conversationId}". A completion report is required.`
      : `If there is substantive information to record, report it back to this Tachikoma thread by calling the \`tachikoma_reply\` tool (or \`tachikoma reply ${conversationId} "<message>"\` if MCP is unavailable) with conversationId "${conversationId}".`,
    "This delivery only starts your turn; it is not captured automatically. Your completion is recorded back to Tachikoma only when you call tachikoma_reply."
  ].join("\n");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
