import type { Command } from "commander";

import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface RequestReviewOptions {
  to: string;
  scope: string;
  claim?: string;
  task?: string;
  thread?: string;
}

interface FindingOptions {
  summary: string;
  request?: string;
  thread?: string;
  claim?: string;
  task?: string;
  to?: string;
}

interface FindingLifecycleOptions {
  finding: string;
  request?: string;
  thread?: string;
  claim?: string;
  task?: string;
  summary?: string;
  reviewer?: string;
}

interface ApproveOptions {
  request: string;
  thread?: string;
  claim?: string;
  task?: string;
  summary?: string;
}

export function registerReviewCommand(program: Command, env: CliExecutionEnvironment): void {
  const review = program.command("review").description("Manage review requests and findings.");

  review
    .command("request")
    .description("Request review from a target.")
    .requiredOption("--to <target>", "Review target.")
    .requiredOption("--scope <scope>", "Review scope.")
    .option("--claim <claim_id>", "Linked implementation claim.")
    .option("--task <task_id>", "Linked task.")
    .option("--thread <thread_id>", "Conversation thread id.")
    .action(async function (this: Command, options: RequestReviewOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const events = runtime.services.reviews.requestReview({
          reviewer: options.to,
          scope: options.scope,
          implementationClaimId: options.claim,
          taskId: options.task,
          conversationId: options.thread
        });
        const request = events.find((event) => event.type === "review.requested");

        env.io.write(`review_request: ${request?.target.reviewRequestId}`);
        env.io.write(`conversation: ${request?.target.conversationId}`);
      });
    });

  review
    .command("finding")
    .description("Record a review finding.")
    .requiredOption("--summary <summary>", "Finding summary.")
    .option("--request <request_id>", "Review request id.")
    .option("--thread <thread_id>", "Conversation thread id.")
    .option("--claim <claim_id>", "Implementation claim id.")
    .option("--task <task_id>", "Task id.")
    .option("--to <target>", "Assignee target.")
    .action(async function (this: Command, options: FindingOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const events = runtime.services.reviews.recordFinding({
          reviewRequestId: options.request,
          conversationId: options.thread,
          implementationClaimId: options.claim,
          taskId: options.task,
          summary: options.summary,
          assignee: options.to
        });
        const finding = events.find((event) => event.type === "review.finding_recorded");

        env.io.write(`review_finding: ${finding?.target.reviewFindingId}`);
        env.io.write(`conversation: ${finding?.target.conversationId ?? options.thread ?? "none"}`);
      });
    });

  review
    .command("address")
    .description("Mark a finding addressed and route it for re-review.")
    .requiredOption("--finding <finding_id>", "Review finding id.")
    .option("--request <request_id>", "Review request id.")
    .option("--thread <thread_id>", "Conversation thread id.")
    .option("--claim <claim_id>", "Implementation claim id.")
    .option("--task <task_id>", "Task id.")
    .option("--summary <summary>", "Addressing summary.")
    .option("--reviewer <target>", "Reviewer target.")
    .action(async function (this: Command, options: FindingLifecycleOptions) {
      await withCliRuntime(this, env, (runtime) => {
        runtime.services.reviews.addressFinding({
          reviewFindingId: options.finding,
          reviewRequestId: options.request,
          conversationId: options.thread,
          implementationClaimId: options.claim,
          taskId: options.task,
          summary: options.summary,
          reviewer: options.reviewer
        });

        env.io.write(`review_finding_addressed: ${options.finding}`);
      });
    });

  review
    .command("accept")
    .description("Accept an addressed finding.")
    .requiredOption("--finding <finding_id>", "Review finding id.")
    .option("--request <request_id>", "Review request id.")
    .option("--thread <thread_id>", "Conversation thread id.")
    .option("--claim <claim_id>", "Implementation claim id.")
    .option("--task <task_id>", "Task id.")
    .option("--summary <summary>", "Acceptance summary.")
    .action(async function (this: Command, options: FindingLifecycleOptions) {
      await withCliRuntime(this, env, (runtime) => {
        runtime.services.reviews.acceptFinding({
          reviewFindingId: options.finding,
          reviewRequestId: options.request,
          conversationId: options.thread,
          implementationClaimId: options.claim,
          taskId: options.task,
          summary: options.summary
        });

        env.io.write(`review_finding_accepted: ${options.finding}`);
      });
    });

  review
    .command("reopen")
    .description("Reopen a finding.")
    .requiredOption("--finding <finding_id>", "Review finding id.")
    .option("--request <request_id>", "Review request id.")
    .option("--thread <thread_id>", "Conversation thread id.")
    .option("--claim <claim_id>", "Implementation claim id.")
    .option("--task <task_id>", "Task id.")
    .option("--summary <summary>", "Reopen summary.")
    .action(async function (this: Command, options: FindingLifecycleOptions) {
      await withCliRuntime(this, env, (runtime) => {
        runtime.services.reviews.reopenFinding({
          reviewFindingId: options.finding,
          reviewRequestId: options.request,
          conversationId: options.thread,
          implementationClaimId: options.claim,
          taskId: options.task,
          summary: options.summary
        });

        env.io.write(`review_finding_reopened: ${options.finding}`);
      });
    });

  review
    .command("approve")
    .description("Approve a review request.")
    .requiredOption("--request <request_id>", "Review request id.")
    .option("--thread <thread_id>", "Conversation thread id.")
    .option("--claim <claim_id>", "Implementation claim id.")
    .option("--task <task_id>", "Task id.")
    .option("--summary <summary>", "Approval summary.")
    .action(async function (this: Command, options: ApproveOptions) {
      await withCliRuntime(this, env, (runtime) => {
        runtime.services.reviews.approveReview({
          reviewRequestId: options.request,
          conversationId: options.thread,
          implementationClaimId: options.claim,
          taskId: options.task,
          summary: options.summary
        });

        env.io.write(`review_approved: ${options.request}`);
      });
    });
}
