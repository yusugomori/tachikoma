import type { Command } from "commander";

import { liveSessionsForEndpoint, openFindings, openThreads } from "../../projections/index.js";
import { formatTarget } from "../io.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

export function registerStatusCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("status")
    .description("Show synchronized project state from projections.")
    .action(async function (this: Command) {
      await withCliRuntime(this, env, (runtime) => {
        const projections = runtime.projections();
        const project = projections.projectState.project;
        const activeTask = projections.tasks.tasks.find(
          (task) => task.id === projections.tasks.activeTaskId
        );
        const pendingInbox = projections.inbox.items.filter(
          (item) => item.status !== "read" && item.status !== "cancelled"
        );
        env.io.write(`Project: ${project?.name ?? "uninitialized"}`);
        env.io.write(
          `Active task: ${activeTask ? `${activeTask.id} ${activeTask.title}` : "none"}`
        );
        env.io.write(`Agents: ${projections.agents.endpoints.length}`);
        for (const endpoint of projections.agents.endpoints) {
          const liveSessions = liveSessionsForEndpoint(projections.agents, endpoint);
          env.io.write(
            `- ${endpoint.name} runtime=${endpoint.runtime} role=${endpoint.role ?? "none"} ${liveSessions.length > 0 ? "live" : "offline"}`
          );
        }

        env.io.write(`Assignments: ${projections.tasks.assignments.length}`);
        for (const assignment of projections.tasks.assignments) {
          env.io.write(
            `- [${assignment.status}] ${assignment.id} target=${formatTarget(assignment.target)} scope=${assignment.scope}`
          );
        }

        env.io.write(`Open conversations: ${openThreads(projections.conversations).length}`);
        env.io.write(`Pending inbox: ${pendingInbox.length}`);
        env.io.write(`Open findings: ${openFindings(projections.reviews).length}`);
        env.io.write(`Verification gaps: ${projections.verification.missingExpectations.length}`);
      });
    });
}
