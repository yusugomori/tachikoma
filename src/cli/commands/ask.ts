import type { Command } from "commander";

import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface AskOptions {
  title?: string;
  task?: string;
  scope?: string;
  replyPolicy?: "required" | "optional" | "none";
}

export function registerAskCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("ask <target> <request>")
    .description("Open a conversation thread and route the first message.")
    .option("--title <title>", "Conversation title.")
    .option("--task <task_id>", "Linked task id.")
    .option("--scope <scope>", "Assignment scope.")
    .option("--reply-policy <policy>", "Reply policy: required, optional, or none.")
    .action(async function (this: Command, target: string, request: string, options: AskOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const events = runtime.services.conversations.ask({
          target,
          body: request,
          title: options.title,
          taskId: options.task,
          scope: options.scope,
          replyPolicy: options.replyPolicy
        });
        const conversationId = events.find((event) => event.type === "conversation.opened")?.target
          .conversationId;
        const message = events.find((event) => event.type === "message.sent");
        const assignment = events.find((event) => event.type === "assignment.created");

        env.io.write(`conversation: ${conversationId}`);
        env.io.write(`message: ${message?.target.messageId}`);
        env.io.write(`assignment: ${assignment?.target.assignmentId}`);
        env.io.write(`target: ${target}`);
      });
    });
}
