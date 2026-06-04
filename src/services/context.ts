import {
  type CreateEventInput,
  createEvent,
  type EventActor,
  type EventEnvelope
} from "../domain/events.js";
import type { IdPrefix } from "../domain/ids.js";
import { createId } from "../domain/ids.js";
import {
  type AgentsProjectionState,
  agentsProjection,
  type BriefProjectionState,
  buildBriefProjectionState,
  type ClaimsProjectionState,
  type ConversationsProjectionState,
  claimsProjection,
  conversationsProjection,
  type InboxProjectionState,
  inboxProjection,
  type ProjectStateProjectionState,
  projectStateProjection,
  type ReviewsProjectionState,
  reviewsProjection,
  runProjection,
  type TasksProjectionState,
  tasksProjection,
  type VerificationProjectionState,
  verificationProjection
} from "../projections/index.js";
import type { EventStore } from "../store/event-store.js";

export interface ProjectContext {
  id: string;
  name?: string;
  repoRoot?: string;
}

export interface ServiceContextOptions {
  project: ProjectContext;
  eventStore: EventStore;
  actor?: EventActor;
  clock?: () => string;
  idGenerator?: (prefix: IdPrefix) => string;
}

export interface ServiceEventInput extends Omit<CreateEventInput, "projectId" | "actor"> {
  projectId?: string;
  actor?: EventActor;
}

export interface ServiceProjectionState {
  projectState: ProjectStateProjectionState;
  agents: AgentsProjectionState;
  inbox: InboxProjectionState;
  tasks: TasksProjectionState;
  claims: ClaimsProjectionState;
  reviews: ReviewsProjectionState;
  verification: VerificationProjectionState;
  conversations: ConversationsProjectionState;
  brief: BriefProjectionState;
}

export class ServiceContext {
  public readonly project: ProjectContext;
  public readonly eventStore: EventStore;
  public readonly actor: EventActor;

  private readonly clock: () => string;
  private readonly idGenerator: (prefix: IdPrefix) => string;

  public constructor(options: ServiceContextOptions) {
    this.project = options.project;
    this.eventStore = options.eventStore;
    this.actor = options.actor ?? {};
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idGenerator = options.idGenerator ?? createId;
  }

  public now(): string {
    return this.clock();
  }

  public id(prefix: IdPrefix): string {
    return this.idGenerator(prefix);
  }

  public withActor(actor: EventActor): ServiceContext {
    return new ServiceContext({
      project: this.project,
      eventStore: this.eventStore,
      actor,
      clock: this.clock,
      idGenerator: this.idGenerator
    });
  }

  public events(): EventEnvelope[] {
    return this.eventStore.listForward(this.project.id);
  }

  public projections(): ServiceProjectionState {
    const events = this.events();
    const projectState = runProjection(projectStateProjection, events).state;
    const agents = runProjection(agentsProjection, events).state;
    const inbox = runProjection(inboxProjection, events).state;
    const tasks = runProjection(tasksProjection, events).state;
    const claims = runProjection(claimsProjection, events).state;
    const reviews = runProjection(reviewsProjection, events).state;
    const verification = runProjection(verificationProjection, events).state;
    const conversations = runProjection(conversationsProjection, events).state;

    return {
      projectState,
      agents,
      inbox,
      tasks,
      claims,
      reviews,
      verification,
      conversations,
      brief: buildBriefProjectionState({
        projectState,
        agents,
        inbox,
        tasks,
        claims,
        reviews,
        verification,
        conversations
      })
    };
  }

  public appendEvents(inputs: ServiceEventInput[]): EventEnvelope[] {
    const events = inputs.map((input) =>
      this.createEvent({
        ...input,
        id: input.id ?? this.id("evt")
      })
    );

    return this.eventStore.appendBatch(events);
  }

  public appendEvent(input: ServiceEventInput): EventEnvelope {
    return this.appendEvents([input])[0] as EventEnvelope;
  }

  public createEvent(input: ServiceEventInput): EventEnvelope {
    return createEvent({
      ...input,
      id: input.id ?? this.id("evt"),
      projectId: input.projectId ?? this.project.id,
      actor: {
        ...this.actor,
        ...input.actor
      },
      createdAt: input.createdAt ?? this.now()
    });
  }
}
