import { z } from "zod";

import type { EventEnvelope } from "../domain/events.js";
import {
  assignmentStatusSchema,
  routingTargetSchema,
  taskStatusSchema
} from "../domain/schemas.js";
import type { ServiceContext } from "./context.js";
import { RoutingService, type RoutingTargetInput } from "./routing-service.js";
import { parseCommandInput } from "./validation.js";

const createTaskInputSchema = z.object({
  id: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
  title: z.string().min(1),
  status: taskStatusSchema.default("planned")
});

const changeTaskStatusInputSchema = z.object({
  taskId: z.string().min(1),
  status: taskStatusSchema
});

const createAssignmentInputSchema = z.object({
  id: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  target: z.union([z.string().min(1), routingTargetSchema]),
  scope: z.string().min(1),
  status: assignmentStatusSchema.default("queued")
});

const changeAssignmentStatusInputSchema = z.object({
  assignmentId: z.string().min(1),
  status: assignmentStatusSchema
});

export type CreateTaskInput = z.input<typeof createTaskInputSchema>;
export type ChangeTaskStatusInput = z.input<typeof changeTaskStatusInputSchema>;
export type CreateAssignmentInput = z.input<typeof createAssignmentInputSchema>;
export type ChangeAssignmentStatusInput = z.input<typeof changeAssignmentStatusInputSchema>;

export class TaskService {
  private readonly routing: RoutingService;

  public constructor(private readonly context: ServiceContext) {
    this.routing = new RoutingService(context);
  }

  public createTask(input: CreateTaskInput): EventEnvelope {
    const parsed = parseCommandInput(createTaskInputSchema, input);
    const taskId = parsed.id ?? this.context.id("task");

    return this.context.appendEvent({
      type: "task.created",
      target: {
        taskId
      },
      payload: {
        title: parsed.title,
        parentTaskId: parsed.parentTaskId,
        status: parsed.status
      }
    });
  }

  public changeTaskStatus(input: ChangeTaskStatusInput): EventEnvelope {
    const parsed = parseCommandInput(changeTaskStatusInputSchema, input);

    return this.context.appendEvent({
      type: "task.status_changed",
      target: {
        taskId: parsed.taskId
      },
      payload: {
        status: parsed.status
      }
    });
  }

  public createAssignment(input: CreateAssignmentInput): EventEnvelope {
    const parsed = parseCommandInput(createAssignmentInputSchema, input);
    const target = this.routing.assertRoutable(parsed.target as RoutingTargetInput);
    const assignmentId = parsed.id ?? this.context.id("assign");

    return this.context.appendEvent({
      type: "assignment.created",
      target: {
        assignmentId,
        taskId: parsed.taskId
      },
      payload: {
        target,
        scope: parsed.scope,
        status: parsed.status
      }
    });
  }

  public changeAssignmentStatus(input: ChangeAssignmentStatusInput): EventEnvelope {
    const parsed = parseCommandInput(changeAssignmentStatusInputSchema, input);

    return this.context.appendEvent({
      type: "assignment.status_changed",
      target: {
        assignmentId: parsed.assignmentId
      },
      payload: {
        status: parsed.status
      }
    });
  }
}
