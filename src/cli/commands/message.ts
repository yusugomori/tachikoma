import type { Command } from "commander";

import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface ReadMessageOptions {
  inbox?: string;
  message?: string;
}

interface SendMessageOptions {
  replyPolicy?: "required" | "optional" | "none";
}

export function registerMessageCommand(program: Command, env: CliExecutionEnvironment): void {
  const message = program.command("message").description("Manage low-level messages.");

  message
    .command("send <thread_id> <target> <body>")
    .description("Send a direct message to a target in a thread.")
    .option("--reply-policy <policy>", "Reply policy: required, optional, or none.")
    .action(async function (
      this: Command,
      threadId: string,
      target: string,
      body: string,
      options: SendMessageOptions
    ) {
      await withCliRuntime(this, env, (runtime) => {
        const event = runtime.services.messages.send({
          conversationId: threadId,
          recipients: [target],
          body,
          replyPolicy: options.replyPolicy
        });

        env.io.write(`message: ${event.target.messageId}`);
      });
    });

  message
    .command("read")
    .description("Mark an inbox item or message as read.")
    .option("--inbox <inbox_item_id>", "Inbox item id.")
    .option("--message <message_id>", "Message id.")
    .action(async function (this: Command, options: ReadMessageOptions) {
      await withCliRuntime(this, env, (runtime) => {
        runtime.services.messages.markRead({
          inboxItemId: options.inbox,
          messageId: options.message
        });
        env.io.write(`read: ${options.inbox ?? options.message}`);
      });
    });
}
