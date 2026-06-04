import type { Command } from "commander";

import { messagesForThread, openThreads } from "../../projections/index.js";
import { formatLinkedRecords, formatParticipant, formatTarget, formatTargets } from "../io.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

export function registerThreadCommand(program: Command, env: CliExecutionEnvironment): void {
  const thread = program.command("thread").description("Inspect conversation threads.");

  thread
    .command("list")
    .description("List conversation threads.")
    .option("--all", "Show closed threads too.")
    .action(async function (this: Command, options: { all?: boolean }) {
      await withCliRuntime(this, env, (runtime) => {
        const conversations = runtime.projections().conversations;
        const threads = options.all ? conversations.threads : openThreads(conversations);

        env.io.write(`threads: ${threads.length}`);
        for (const item of threads) {
          env.io.write(`- [${item.status}] ${item.id} ${item.title}`);
        }
      });
    });

  thread
    .command("show <thread_id>")
    .description("Show a conversation exchange and linked structured records.")
    .action(async function (this: Command, threadId: string) {
      await withCliRuntime(this, env, (runtime) => {
        const projections = runtime.projections();
        const item = projections.conversations.threads.find((thread) => thread.id === threadId);

        if (!item) {
          throw new Error(`Thread not found: ${threadId}`);
        }

        env.io.write(`thread: ${item.id}`);
        env.io.write(`title: ${item.title}`);
        env.io.write(`status: ${item.status}`);
        env.io.write(`participants: ${item.participants.map(formatParticipant).join(", ")}`);
        env.io.write(`linked: ${formatLinkedRecords(item.linkedRecords)}`);
        env.io.write("messages:");
        const messages = messagesForThread(projections.conversations, item.id);

        for (const message of messages) {
          env.io.write(
            `- ${message.createdAt} ${formatParticipant(message.sender)} -> ${formatTargets(message.recipients)}: ${message.body}`
          );
          if (message.linkedRecords.length > 0) {
            env.io.write(`  linked: ${formatLinkedRecords(message.linkedRecords)}`);
          }
        }

        const linkedRecords = [
          ...item.linkedRecords,
          ...messages.flatMap((message) => message.linkedRecords)
        ];
        const assignments = projections.tasks.assignments.filter((assignment) =>
          linkedRecords.some(
            (record) => record.kind === "assignment" && record.id === assignment.id
          )
        );
        const claims = projections.claims.claims.filter(
          (claim) => claim.conversationId === item.id
        );
        const reviewRequests = projections.reviews.requests.filter(
          (request) => request.conversationId === item.id
        );
        const reviewFindings = projections.reviews.findings.filter(
          (finding) => finding.conversationId === item.id
        );
        const verification = projections.verification.results.filter(
          (result) => result.conversationId === item.id
        );

        env.io.write("structured records:");
        for (const assignment of assignments) {
          env.io.write(
            `- assignment ${assignment.id} [${assignment.status}] target=${formatTarget(assignment.target)} scope=${assignment.scope}`
          );
        }
        for (const claim of claims) {
          env.io.write(`- implementation_claim ${claim.id}: ${claim.summary}`);
        }
        for (const request of reviewRequests) {
          env.io.write(
            `- review_request ${request.id} target=${formatTarget(request.target)} scope=${request.scope}`
          );
        }
        for (const finding of reviewFindings) {
          env.io.write(`- review_finding ${finding.id} [${finding.status}] ${finding.summary}`);
        }
        for (const result of verification) {
          env.io.write(`- verification_result ${result.id} [${result.status}] ${result.summary}`);
        }
      });
    });
}
