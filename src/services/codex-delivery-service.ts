import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

import {
  CodexAppServerClient,
  type CodexThreadMessage,
  type CodexThreadSummary,
  latestAssistantMessage,
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
import { ConversationService } from "./conversation-service.js";
import type { DeliveryDirective } from "./delivery-service.js";
import { DeliveryService } from "./delivery-service.js";
import { MessageService } from "./message-service.js";
import { parseCommandInput } from "./validation.js";

const codexDeliverPendingInputSchema = z.object({
  agentName: z.string().min(1),
  maxItems: z.number().int().positive().default(5),
  waitForCompletionMs: z.number().int().nonnegative().default(60000),
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
  sessionId: string;
  deliveryMode: DeliveryMode;
  directive: DeliveryDirective;
  waitForCompletionMs: number;
}

interface WaitForAssistantReplyInput {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  timeoutMs: number;
}

interface WaitForAssistantReplyResult {
  reply?: CodexThreadMessage;
  warnings: string[];
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

      for (const directive of actionableDirectives) {
        const outcome = await this.deliverOne({
          client: handle.client,
          threadId: activeWorker.codexThreadId ?? deliveryThread.id,
          cwd: deliveryThread.cwd ?? this.repoRoot(),
          endpoint: batch.endpoint,
          sessionId: batch.session.id,
          deliveryMode: batch.deliveryMode,
          directive,
          waitForCompletionMs: parsed.waitForCompletionMs
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

      const wait = await this.waitForAssistantReply({
        client: input.client,
        threadId: input.threadId,
        turnId: turn.id,
        timeoutMs: input.waitForCompletionMs
      });
      const reply = wait.reply;

      if (!reply?.text) {
        return this.failOne(
          input,
          attemptId,
          events,
          wait.warnings.at(-1) ??
            "thread/read did not include an assistant reply for the delivered turn.",
          wait.warnings
        );
      }

      events.push(
        ...new ConversationService(
          this.context.withActor({
            name: input.endpoint.name,
            agentId: input.endpoint.id,
            runtime: input.endpoint.runtime,
            role: input.endpoint.role,
            sessionId: input.sessionId
          })
        ).replyToThread({
          conversationId: input.directive.conversationId,
          body: reply.text,
          linkedRecords: input.directive.linkedRecords
        })
      );
      events.push(
        this.messages.recordDeliveryDelivered({
          id: attemptId,
          inboxItemId: input.directive.inboxItemId,
          messageId: input.directive.messageId,
          recipient: input.directive.target,
          deliveryMode: input.deliveryMode,
          outcome: "replied"
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

  private async waitForAssistantReply(
    input: WaitForAssistantReplyInput
  ): Promise<WaitForAssistantReplyResult> {
    if (input.timeoutMs <= 0) {
      return {
        reply: await this.readLatestAssistantReply(input.client, input.threadId, input.turnId),
        warnings: []
      };
    }

    const deadline = Date.now() + input.timeoutMs;
    let notificationSettled = false;
    let notificationWarning: string | undefined;
    let readWarning: string | undefined;

    void input.client
      .waitForTurnCompleted({
        threadId: input.threadId,
        turnId: input.turnId,
        timeoutMs: input.timeoutMs
      })
      .then(() => {
        notificationSettled = true;
      })
      .catch((error: unknown) => {
        notificationSettled = true;
        notificationWarning = error instanceof Error ? error.message : String(error);
      });

    while (Date.now() <= deadline) {
      try {
        const reply = await this.readLatestAssistantReply(
          input.client,
          input.threadId,
          input.turnId
        );

        if (reply?.text) {
          return {
            reply,
            warnings: []
          };
        }
      } catch (error) {
        readWarning = error instanceof Error ? error.message : String(error);
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      await sleep(Math.min(notificationSettled && !notificationWarning ? 250 : 1000, remainingMs));
    }

    try {
      const reply = await this.readLatestAssistantReply(input.client, input.threadId, input.turnId);

      if (reply?.text) {
        return {
          reply,
          warnings: []
        };
      }
    } catch (error) {
      readWarning = error instanceof Error ? error.message : String(error);
    }

    return {
      warnings: uniqueStrings(
        [
          notificationWarning,
          readWarning,
          "thread/read did not include an assistant reply for the delivered turn."
        ].filter((warning): warning is string => Boolean(warning))
      )
    };
  }

  private async readLatestAssistantReply(
    client: CodexAppServerClient,
    threadId: string,
    turnId: string
  ): Promise<CodexThreadMessage | undefined> {
    const thread = await client.readThreadNormalized(threadId);
    const reply = latestAssistantMessage(thread, turnId);

    if (reply?.text) {
      return reply;
    }

    const turnItems = await client.listTurnItemsNormalized({
      threadId,
      turnId
    });

    return latestAssistantMessage(turnItems, turnId);
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

function formatDirectivePrompt(directive: DeliveryDirective, agentName: string): string {
  const linkedRecords =
    directive.linkedRecords.length > 0
      ? directive.linkedRecords.map((record) => `${record.kind}:${record.id}`).join(", ")
      : "none";

  return [
    `Tachikoma delivery for ${agentName}.`,
    `Thread: ${directive.conversationId ?? "unknown"}`,
    `Message: ${directive.messageId ?? "unknown"}`,
    `Inbox item: ${directive.inboxItemId}`,
    `Reason: ${directive.reason}`,
    `Reply policy: ${directive.replyPolicy}`,
    `Linked records: ${linkedRecords}`,
    "",
    "This Codex app-server delivery records your assistant response back to Tachikoma automatically. Do not call tachikoma_reply or `tachikoma reply` from this turn.",
    "",
    "Request:",
    directive.body ?? "(no body)",
    "",
    directive.replyPolicy === "required"
      ? "Reply with only the message that should be recorded back to the Tachikoma thread."
      : "Reply only when there is substantive information to record back to the Tachikoma thread."
  ].join("\n");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
