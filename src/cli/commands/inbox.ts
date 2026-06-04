import type { Command } from "commander";

import {
  endpointByName,
  getInboxForAgentName,
  type InboxProjectionItem,
  selectInboxDismissCandidates
} from "../../projections/index.js";
import { formatParticipant, formatTarget, truncate } from "../io.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface InboxOptions {
  as?: string;
}

interface InboxGlobalOptions {
  as?: string;
}

interface InboxDismissOptions {
  as?: string;
  dryRun?: boolean;
  includeShared?: boolean;
  reason?: string;
}

const SHARED_HINT = "(use --include-shared to dismiss role/broadcast items)";

export function registerInboxCommand(program: Command, env: CliExecutionEnvironment): void {
  const inbox = program
    .command("inbox")
    .description("Show pending inbox items.")
    .option("--as <agent_name>", "View inbox for a registered agent name.")
    .action(async function (this: Command, options: InboxOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const globalOptions = this.optsWithGlobals<InboxGlobalOptions>();
        const agentName = options.as ?? globalOptions.as;
        const projections = runtime.projections();
        const items = agentName
          ? getInboxForAgentName(projections.inbox, projections.agents, agentName)
          : projections.inbox.items.filter(
              (item) => item.status !== "read" && item.status !== "cancelled"
            );

        env.io.write(`inbox: ${agentName ?? "project"} (${items.length})`);

        for (const item of items) {
          const sender = item.sender ? ` from=${formatParticipant(item.sender)}` : "";
          const body = item.body ? ` body="${truncate(item.body, 120)}"` : "";
          const conversation = item.conversationId ? ` thread=${item.conversationId}` : "";
          const message = item.messageId ? ` message=${item.messageId}` : "";
          env.io.write(
            `- [${item.status}] ${item.id} target=${formatTarget(item.target)} reason=${item.reason}${sender}${conversation}${message}${body}`
          );
        }
      });
    });

  inbox
    .command("dismiss")
    .description("Dismiss stale or irrelevant inbox items for an agent (maintenance cleanup).")
    .option("--as <agent_name>", "Target agent inbox. Falls back to the global --as option.")
    .option("--dry-run", "Print the dismiss candidates without writing any events.")
    .option(
      "--include-shared",
      "Also dismiss matching shared role/runtime-role/broadcast items that may affect other agents."
    )
    .option("--reason <text>", "Audit reason recorded with each dismissal.")
    .action(async function (this: Command, options: InboxDismissOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const globalOptions = this.optsWithGlobals<InboxGlobalOptions>();
        const agentName = options.as ?? globalOptions.as;

        if (!agentName) {
          throw new Error("inbox dismiss requires --as <agent_name> or global --as <agent_name>.");
        }

        const projections = runtime.projections();

        if (!endpointByName(projections.agents, agentName)) {
          throw new Error(`inbox dismiss: unknown agent "${agentName}".`);
        }

        const { dismissible, shared } = selectInboxDismissCandidates(
          projections.inbox,
          projections.agents,
          agentName
        );
        const includeShared = options.includeShared === true;
        const toDismiss = includeShared ? [...dismissible, ...shared] : dismissible;
        const sharedSkipped = includeShared ? 0 : shared.length;

        if (options.dryRun === true) {
          const sharedLabel = includeShared ? "shared_included" : "shared_skipped";
          env.io.write(
            `dismiss dry-run: ${agentName} direct=${dismissible.length} ${sharedLabel}=${shared.length}`
          );
          for (const item of toDismiss) {
            env.io.write(formatDismissCandidate(item));
          }
          if (sharedSkipped > 0) {
            env.io.write(`shared skipped: ${sharedSkipped} ${SHARED_HINT}`);
          }
          return;
        }

        const reason = options.reason ?? "manual inbox cleanup";
        for (const item of toDismiss) {
          runtime.services.messages.dismissInboxItem({
            inboxItemId: item.id,
            reason
          });
        }

        env.io.write(`dismissed inbox: ${agentName} count=${toDismiss.length}`);
        for (const item of toDismiss) {
          env.io.write(`- ${item.id}`);
        }
        if (sharedSkipped > 0) {
          env.io.write(`shared skipped: ${sharedSkipped} ${SHARED_HINT}`);
        }
      });
    });
}

function formatDismissCandidate(item: InboxProjectionItem): string {
  const conversation = item.conversationId ? ` thread=${item.conversationId}` : "";
  const message = item.messageId ? ` message=${item.messageId}` : "";
  const body = item.body ? ` body="${truncate(item.body, 120)}"` : "";
  return `- [${item.status}] ${item.id}${conversation}${message}${body}`;
}
