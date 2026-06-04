import type { EventEnvelope } from "../domain/events.js";
import type { ServiceProjectionState } from "../services/context.js";

export interface ProjectSnapshotInput {
  projections: ServiceProjectionState;
  events: EventEnvelope[];
  generatedAt?: string;
}

export interface ProjectSnapshot {
  generatedAt: string;
  project: ServiceProjectionState["projectState"]["project"] | null;
  eventLog: {
    count: number;
    lastEventId?: string;
    lastEventAt?: string;
    counts: ServiceProjectionState["projectState"]["eventCounts"];
    recentEventIds: string[];
  };
  agents: ServiceProjectionState["agents"];
  tasks: ServiceProjectionState["tasks"];
  claims: ServiceProjectionState["claims"];
  reviews: ServiceProjectionState["reviews"];
  verification: ServiceProjectionState["verification"];
  conversations: ServiceProjectionState["conversations"];
  inbox: ServiceProjectionState["inbox"];
  memory: ServiceProjectionState["brief"];
}

export function createProjectSnapshot(input: ProjectSnapshotInput): ProjectSnapshot {
  const recentEventIds = input.events.slice(-20).map((event) => event.id);

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    project: input.projections.projectState.project ?? null,
    eventLog: {
      count: input.events.length,
      lastEventId: input.projections.projectState.lastEventId,
      lastEventAt: input.projections.projectState.lastEventAt,
      counts: input.projections.projectState.eventCounts,
      recentEventIds
    },
    agents: input.projections.agents,
    tasks: input.projections.tasks,
    claims: input.projections.claims,
    reviews: input.projections.reviews,
    verification: input.projections.verification,
    conversations: input.projections.conversations,
    inbox: input.projections.inbox,
    memory: input.projections.brief
  };
}

export function renderProjectSnapshotJson(snapshot: ProjectSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
