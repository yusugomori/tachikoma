import type { EventEnvelope } from "../domain/events.js";
import type { Assignment, Task } from "../domain/types.js";
import {
  payloadRecord,
  readAssignmentStatus,
  readRoutingTarget,
  readString,
  readTaskStatus
} from "./event-readers.js";
import type { Projection } from "./types.js";

export interface TasksProjectionState {
  tasks: Task[];
  assignments: Assignment[];
  activeTaskId?: string;
}

export const tasksProjection: Projection<TasksProjectionState> = {
  name: "tasks",
  initialState: () => ({
    tasks: [],
    assignments: []
  }),
  apply: (state, event) => {
    switch (event.type) {
      case "task.created":
        return applyTaskCreated(state, event);
      case "task.status_changed":
        return applyTaskStatusChanged(state, event);
      case "assignment.created":
        return applyAssignmentCreated(state, event);
      case "assignment.status_changed":
        return applyAssignmentStatusChanged(state, event);
      default:
        return state;
    }
  }
};

function applyTaskCreated(state: TasksProjectionState, event: EventEnvelope): TasksProjectionState {
  const payload = payloadRecord(event);
  const taskId = event.target.taskId ?? readString(payload, "taskId");
  const title = readString(payload, "title");

  if (!taskId || !title) {
    return state;
  }

  const task: Task = {
    id: taskId,
    projectId: event.projectId,
    parentTaskId: event.target.taskId ? readString(payload, "parentTaskId") : undefined,
    title,
    status: readTaskStatus(payload.status) ?? "planned",
    createdAt: event.createdAt,
    updatedAt: event.createdAt
  };

  return {
    ...state,
    tasks: upsertTask(state.tasks, task),
    activeTaskId: state.activeTaskId ?? task.id
  };
}

function applyTaskStatusChanged(
  state: TasksProjectionState,
  event: EventEnvelope
): TasksProjectionState {
  const payload = payloadRecord(event);
  const taskId = event.target.taskId ?? readString(payload, "taskId");
  const status = readTaskStatus(payload.status);

  if (!taskId || !status) {
    return state;
  }

  const tasks = state.tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          status,
          updatedAt: event.createdAt
        }
      : task
  );

  return {
    ...state,
    tasks,
    activeTaskId: chooseActiveTask(tasks)
  };
}

function applyAssignmentCreated(
  state: TasksProjectionState,
  event: EventEnvelope
): TasksProjectionState {
  const payload = payloadRecord(event);
  const assignmentId = event.target.assignmentId ?? readString(payload, "assignmentId");
  const target = readRoutingTarget(payload.target);
  const scope = readString(payload, "scope");

  if (!assignmentId || !target || !scope) {
    return state;
  }

  const assignment: Assignment = {
    id: assignmentId,
    projectId: event.projectId,
    taskId: event.target.taskId ?? readString(payload, "taskId"),
    target,
    status: readAssignmentStatus(payload.status) ?? "queued",
    scope,
    createdAt: event.createdAt,
    updatedAt: event.createdAt
  };

  return {
    ...state,
    assignments: upsertAssignment(state.assignments, assignment)
  };
}

function applyAssignmentStatusChanged(
  state: TasksProjectionState,
  event: EventEnvelope
): TasksProjectionState {
  const payload = payloadRecord(event);
  const assignmentId = event.target.assignmentId ?? readString(payload, "assignmentId");
  const status = readAssignmentStatus(payload.status);

  if (!assignmentId || !status) {
    return state;
  }

  return {
    ...state,
    assignments: state.assignments.map((assignment) =>
      assignment.id === assignmentId
        ? {
            ...assignment,
            status,
            updatedAt: event.createdAt
          }
        : assignment
    )
  };
}

function upsertTask(tasks: Task[], task: Task): Task[] {
  const next = tasks.some((candidate) => candidate.id === task.id)
    ? tasks.map((candidate) => (candidate.id === task.id ? task : candidate))
    : [...tasks, task];

  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function upsertAssignment(assignments: Assignment[], assignment: Assignment): Assignment[] {
  const next = assignments.some((candidate) => candidate.id === assignment.id)
    ? assignments.map((candidate) => (candidate.id === assignment.id ? assignment : candidate))
    : [...assignments, assignment];

  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function chooseActiveTask(tasks: Task[]): string | undefined {
  const active = tasks.find((task) => !["done", "blocked"].includes(task.status));
  return active?.id;
}
