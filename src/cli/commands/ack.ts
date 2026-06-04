import type { Command } from "commander";

import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

export function registerAckCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("ack <inbox_item_id>")
    .description("Acknowledge an inbox item without sending a conversation reply.")
    .action(async function (this: Command, inboxItemId: string) {
      await withCliRuntime(this, env, (runtime) => {
        runtime.services.messages.markRead({
          inboxItemId
        });

        env.io.write(`ack: ${inboxItemId}`);
      });
    });
}
