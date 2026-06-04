import type { Command } from "commander";

import type { VerificationStatus } from "../../domain/types.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface VerificationRecordOptions {
  status: VerificationStatus;
  summary: string;
  task?: string;
  thread?: string;
  claim?: string;
  finding?: string;
  command?: string;
  notify?: boolean;
}

export function registerVerificationCommand(program: Command, env: CliExecutionEnvironment): void {
  const verification = program.command("verification").description("Record verification results.");

  verification
    .command("record")
    .description("Record a verification result.")
    .requiredOption("--status <status>", "passed, failed, skipped, or manual_pending.")
    .requiredOption("--summary <summary>", "Verification summary.")
    .option("--task <task_id>", "Task id.")
    .option("--thread <thread_id>", "Conversation thread id.")
    .option("--claim <claim_id>", "Implementation claim id.")
    .option("--finding <finding_id>", "Review finding id.")
    .option("--command <command>", "Verification command.")
    .option("--no-notify", "Do not route failed verification.")
    .action(async function (this: Command, options: VerificationRecordOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const events = runtime.services.verification.record({
          status: options.status,
          summary: options.summary,
          taskId: options.task,
          conversationId: options.thread,
          implementationClaimId: options.claim,
          reviewFindingId: options.finding,
          command: options.command,
          notifyOnFailure: options.notify !== false
        });
        const record = events.find((event) => event.type === "verification.recorded");

        env.io.write(`verification_result: ${record?.target.verificationId}`);
      });
    });
}
