import type { Command } from "commander";

import { formatTargets } from "../io.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface ReplyOptions {
  replyPolicy?: "required" | "optional" | "none";
}

export function registerReplyCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("reply <thread_id> <message>")
    .description("Reply in an existing conversation thread.")
    .option(
      "--reply-policy <policy>",
      "Reply policy for routed recipients: required, optional, or none."
    )
    .action(async function (
      this: Command,
      threadId: string,
      message: string,
      options: ReplyOptions
    ) {
      await withCliRuntime(this, env, (runtime) => {
        const events = runtime.services.conversations.replyToThread({
          conversationId: threadId,
          body: message,
          replyPolicy: options.replyPolicy
        });
        const sent = events.find((event) => event.type === "message.sent");
        const routed = events.find((event) => event.type === "conversation.message_routed");
        const projected = runtime
          .projections()
          .conversations.messages.find((candidate) => candidate.id === sent?.target.messageId);
        const recipients = projected?.recipients ?? [];

        env.io.write(`conversation: ${threadId}`);
        env.io.write(`message: ${sent?.target.messageId}`);
        env.io.write(`routed: ${formatTargets(recipients)}`);
        env.io.write(`route: ${routed?.id}`);
      });
    });
}
