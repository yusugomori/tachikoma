import type { Command } from "commander";

import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface ClaimRecordOptions {
  task?: string;
  assignment?: string;
  thread?: string;
  session?: string;
  agent?: string;
  summary: string;
  file?: string[];
  addressedFinding?: string[];
  expect?: string;
  requestReview?: boolean;
  reviewer?: string;
  reviewScope?: string;
}

export function registerClaimCommand(program: Command, env: CliExecutionEnvironment): void {
  const claim = program.command("claim").description("Record implementation claims.");

  claim
    .command("record")
    .description("Record that implementation work was completed.")
    .option("--task <task_id>", "Linked task id.")
    .option("--assignment <assignment_id>", "Linked assignment id.")
    .option("--thread <thread_id>", "Linked conversation thread id.")
    .option("--session <session_id>", "Session id.")
    .option("--agent <agent_id>", "Agent endpoint id.")
    .requiredOption("--summary <summary>", "Implementation summary.")
    .option("--file <path>", "Changed file.", collect, [])
    .option("--addressed-finding <finding_id>", "Addressed finding id.", collect, [])
    .option("--expect <summary>", "Verification expectation.")
    .option("--request-review", "Route a review request after recording the claim.")
    .option("--reviewer <target>", "Review target.")
    .option("--review-scope <scope>", "Review request scope.")
    .action(async function (this: Command, options: ClaimRecordOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const shouldRequestReview =
          options.requestReview === true ||
          Boolean(options.reviewer) ||
          Boolean(options.reviewScope);
        const events = runtime.services.implementation.recordClaim({
          taskId: options.task,
          assignmentId: options.assignment,
          conversationId: options.thread,
          sessionId: options.session,
          agentId: options.agent,
          summary: options.summary,
          files: options.file ?? [],
          addressedFindingIds: options.addressedFinding ?? [],
          verificationExpectation: options.expect,
          requestReview: shouldRequestReview
            ? {
                reviewer: options.reviewer,
                scope: options.reviewScope
              }
            : false
        });
        const claimEvent = events.find((event) => event.type === "implementation.claim_recorded");
        const reviewEvent = events.find((event) => event.type === "review.requested");

        env.io.write(`claim: ${claimEvent?.target.implementationClaimId}`);
        if (reviewEvent) {
          env.io.write(`review_request: ${reviewEvent.target.reviewRequestId}`);
          env.io.write(`conversation: ${reviewEvent.target.conversationId}`);
        }
      });
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
