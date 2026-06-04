import { AgentService } from "./agent-service.js";
import { CodexDeliveryService } from "./codex-delivery-service.js";
import type { ServiceContext } from "./context.js";
import { ConversationService } from "./conversation-service.js";
import { DecisionService } from "./decision-service.js";
import { DeliveryService } from "./delivery-service.js";
import { HandoffService } from "./handoff-service.js";
import { ImplementationService } from "./implementation-service.js";
import { KnowledgeService } from "./knowledge-service.js";
import { MessageService } from "./message-service.js";
import { ProjectService } from "./project-service.js";
import { ReportService } from "./report-service.js";
import { ReviewService } from "./review-service.js";
import { RoutingService } from "./routing-service.js";
import { SessionService } from "./session-service.js";
import { TaskService } from "./task-service.js";
import { VerificationService } from "./verification-service.js";

export * from "./agent-service.js";
export * from "./codex-delivery-service.js";
export * from "./context.js";
export * from "./conversation-service.js";
export * from "./decision-service.js";
export * from "./delivery-service.js";
export * from "./handoff-service.js";
export * from "./implementation-service.js";
export * from "./install-service.js";
export * from "./knowledge-service.js";
export * from "./message-service.js";
export * from "./participants.js";
export * from "./project-service.js";
export * from "./report-service.js";
export * from "./reset-service.js";
export * from "./review-service.js";
export * from "./routing-service.js";
export * from "./session-service.js";
export * from "./task-service.js";
export * from "./transaction.js";
export * from "./uninstall-service.js";
export * from "./validation.js";
export * from "./verification-service.js";

export interface Services {
  project: ProjectService;
  agents: AgentService;
  sessions: SessionService;
  routing: RoutingService;
  delivery: DeliveryService;
  codexDelivery: CodexDeliveryService;
  tasks: TaskService;
  messages: MessageService;
  conversations: ConversationService;
  decisions: DecisionService;
  knowledge: KnowledgeService;
  implementation: ImplementationService;
  reviews: ReviewService;
  verification: VerificationService;
  handoffs: HandoffService;
  reports: ReportService;
}

export function createServices(context: ServiceContext): Services {
  return {
    project: new ProjectService(context),
    agents: new AgentService(context),
    sessions: new SessionService(context),
    routing: new RoutingService(context),
    delivery: new DeliveryService(context),
    codexDelivery: new CodexDeliveryService(context),
    tasks: new TaskService(context),
    messages: new MessageService(context),
    conversations: new ConversationService(context),
    decisions: new DecisionService(context),
    knowledge: new KnowledgeService(context),
    implementation: new ImplementationService(context),
    reviews: new ReviewService(context),
    verification: new VerificationService(context),
    handoffs: new HandoffService(context),
    reports: new ReportService(context)
  };
}
