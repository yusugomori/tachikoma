import type { Command } from "commander";

import type { AssignmentStatus, TaskStatus } from "../../domain/types.js";
import { type CliExecutionEnvironment, withCliRuntime } from "../runtime.js";

interface CreateTaskOptions {
  parent?: string;
  status?: TaskStatus;
}

interface AssignTaskOptions {
  task?: string;
  status?: AssignmentStatus;
}

export function registerTaskCommand(program: Command, env: CliExecutionEnvironment): void {
  const task = program.command("task").description("Manage tasks and assignments.");

  task
    .command("create <title>")
    .description("Create a task.")
    .option("--parent <task_id>", "Parent task id.")
    .option("--status <status>", "Initial task status.", "planned")
    .action(async function (this: Command, title: string, options: CreateTaskOptions) {
      await withCliRuntime(this, env, (runtime) => {
        const event = runtime.services.tasks.createTask({
          title,
          parentTaskId: options.parent,
          status: options.status ?? "planned"
        });

        env.io.write(`task: ${event.target.taskId}`);
      });
    });

  task
    .command("status <task_id> <status>")
    .description("Change task status.")
    .action(async function (this: Command, taskId: string, status: TaskStatus) {
      await withCliRuntime(this, env, (runtime) => {
        runtime.services.tasks.changeTaskStatus({ taskId, status });
        env.io.write(`task status: ${taskId} ${status}`);
      });
    });

  task
    .command("assign <target> <scope>")
    .description("Create an assignment.")
    .option("--task <task_id>", "Linked task id.")
    .option("--status <status>", "Initial assignment status.", "queued")
    .action(async function (
      this: Command,
      target: string,
      scope: string,
      options: AssignTaskOptions
    ) {
      await withCliRuntime(this, env, (runtime) => {
        const event = runtime.services.tasks.createAssignment({
          target,
          scope,
          taskId: options.task,
          status: options.status ?? "queued"
        });

        env.io.write(`assignment: ${event.target.assignmentId}`);
      });
    });
}
