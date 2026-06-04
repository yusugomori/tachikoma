import type { EventEnvelope, EventType } from "../domain/events.js";
import type { Project } from "../domain/types.js";
import { payloadRecord, readString } from "./event-readers.js";
import type { Projection } from "./types.js";

export interface ProjectStateProjectionState {
  project?: Project;
  eventCounts: Partial<Record<EventType, number>>;
  lastEventId?: string;
  lastEventAt?: string;
}

export const projectStateProjection: Projection<ProjectStateProjectionState> = {
  name: "project-state",
  initialState: () => ({
    eventCounts: {}
  }),
  apply: (state, event) => {
    const next: ProjectStateProjectionState = {
      ...state,
      eventCounts: {
        ...state.eventCounts,
        [event.type]: (state.eventCounts[event.type] ?? 0) + 1
      },
      lastEventId: event.id,
      lastEventAt: event.createdAt
    };

    if (event.type === "project.initialized") {
      const payload = payloadRecord(event);
      const name = readString(payload, "name") ?? event.projectId;

      next.project = {
        id: event.projectId,
        name,
        repoRoot: readString(payload, "repoRoot"),
        createdAt: event.createdAt
      };
    }

    return next;
  }
};

export function applyProjectStateProjection(events: EventEnvelope[]): ProjectStateProjectionState {
  return events.reduce(projectStateProjection.apply, projectStateProjection.initialState());
}
