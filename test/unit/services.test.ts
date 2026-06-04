import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RoutingTargetAmbiguousError,
  RoutingTargetNotFoundError,
  ValidationError
} from "../../src/domain/errors.js";
import {
  getInboxForAgentName,
  type InboxProjectionItem,
  messagesForThread
} from "../../src/projections/index.js";
import { createServices, ServiceContext } from "../../src/services/index.js";
import { EventStore } from "../../src/store/event-store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("command services", () => {
  it("appends events for state-changing commands and returns structured validation errors", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.project.initialize({ name: "tachikoma" });
      services.agents.registerEndpoint({
        id: "agent_codex",
        name: "loki",
        runtime: "codex",
        role: "reviewer"
      });
      services.sessions.start({
        id: "sess_codex",
        name: "loki",
        capabilities: ["inbox"]
      });
      services.tasks.createTask({ id: "task_service", title: "Build services" });
      services.tasks.createAssignment({
        id: "assign_service",
        taskId: "task_service",
        target: "loki",
        scope: "review service layer"
      });
      services.tasks.changeTaskStatus({
        taskId: "task_service",
        status: "in_progress"
      });
      services.tasks.changeAssignmentStatus({
        assignmentId: "assign_service",
        status: "in_progress"
      });
      services.conversations.openThread({
        id: "conv_service",
        title: "Service thread"
      });
      services.conversations.closeThread({
        conversationId: "conv_service",
        reason: "Covered by unit tests."
      });
      services.verification.record({
        id: "vr_service",
        taskId: "task_service",
        status: "passed",
        summary: "Unit tests pass."
      });
      services.sessions.end({
        sessionId: "sess_codex"
      });
      services.decisions.record({
        id: "dec_service",
        taskId: "task_service",
        summary: "Use command services",
        rationale: "Adapters should not write storage directly."
      });
      services.knowledge.record({
        id: "kn_service",
        taskId: "task_service",
        title: "Service contract",
        body: "All state-changing commands append events."
      });
      services.handoffs.generate({
        id: "handoff_service",
        taskId: "task_service",
        summary: "Ready for CLI integration."
      });
      services.reports.export({
        id: "report_service",
        path: "reports/status.md",
        format: "markdown"
      });

      expect(eventTypes(fixture)).toEqual(
        expect.arrayContaining([
          "project.initialized",
          "agent.endpoint_registered",
          "session.started",
          "agent.presence_announced",
          "session.ended",
          "task.created",
          "task.status_changed",
          "assignment.created",
          "assignment.status_changed",
          "conversation.opened",
          "conversation.closed",
          "verification.recorded",
          "decision.recorded",
          "knowledge.recorded",
          "handoff.generated",
          "report.exported"
        ])
      );
      expect(() =>
        services.agents.registerEndpoint({
          name: "",
          runtime: "codex",
          role: "reviewer"
        })
      ).toThrow(ValidationError);
    } finally {
      fixture.store.close();
    }
  });

  it("lets a running session join by name and takeover an existing live session", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      const first = services.sessions.join({
        id: "sess_claude_1",
        name: "musashi",
        runtime: "claude",
        role: "implementer"
      });

      expect(first.endpointCreated).toBe(true);
      expect(first.sessionId).toBe("sess_claude_1");
      expect(fixture.context.projections().agents.endpoints).toMatchObject([
        {
          name: "musashi",
          runtime: "claude",
          role: "implementer"
        }
      ]);

      expect(() =>
        services.sessions.join({
          id: "sess_claude_2",
          name: "musashi"
        })
      ).toThrow(ValidationError);

      const takeover = services.sessions.join({
        id: "sess_claude_2",
        name: "musashi",
        takeover: true
      });
      const sessions = fixture.context.projections().agents.sessions;

      expect(takeover.endedSessionIds).toEqual(["sess_claude_1"]);
      expect(sessions.find((session) => session.id === "sess_claude_1")?.endedAt).toBeDefined();
      expect(sessions.find((session) => session.id === "sess_claude_2")?.endedAt).toBeUndefined();
    } finally {
      fixture.store.close();
    }
  });

  it("allows role-less named agents and arbitrary optional role labels", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.agents.registerEndpoint({
        id: "agent_musashi",
        name: "musashi",
        runtime: "claude"
      });
      const roleless = services.sessions.join({
        id: "sess_musashi",
        name: "musashi",
        deliveryMode: "off"
      });
      const labeled = services.sessions.join({
        id: "sess_loki",
        name: "loki",
        runtime: "codex",
        role: "tachikoma-logic-reviewer",
        deliveryMode: "off"
      });
      const agents = fixture.context.projections().agents;

      expect(roleless.endpointCreated).toBe(false);
      expect(labeled.endpointCreated).toBe(true);
      expect(agents.endpoints.find((endpoint) => endpoint.name === "musashi")).toMatchObject({
        name: "musashi",
        runtime: "claude"
      });
      expect(
        agents.endpoints.find((endpoint) => endpoint.name === "musashi")?.role
      ).toBeUndefined();
      expect(agents.endpoints.find((endpoint) => endpoint.name === "loki")).toMatchObject({
        name: "loki",
        runtime: "codex",
        role: "tachikoma-logic-reviewer"
      });
      expect(
        agents.sessions.find((session) => session.id === "sess_musashi")?.role
      ).toBeUndefined();
    } finally {
      fixture.store.close();
    }
  });

  it("queues exact offline named work and rejects ambiguous role routing", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerClaudeImpl(services);
      services.agents.registerEndpoint({
        id: "agent_reviewer_a",
        name: "loki-a",
        runtime: "codex",
        role: "reviewer"
      });
      services.agents.registerEndpoint({
        id: "agent_reviewer_b",
        name: "loki-b",
        runtime: "codex",
        role: "reviewer"
      });

      expect(services.routing.resolve("musashi")).toMatchObject({
        status: "resolved",
        delivery: "queued"
      });
      expect(() =>
        services.routing.resolve({
          kind: "role",
          role: "reviewer"
        })
      ).toThrow(RoutingTargetAmbiguousError);
      expect(() => services.routing.resolve("unknown-agent")).toThrow(RoutingTargetNotFoundError);
    } finally {
      fixture.store.close();
    }
  });

  it("ask opens a thread, creates a message, creates an assignment, and queues inbox work", () => {
    const fixture = openFixture();
    const rootServices = createServices(fixture.context);

    try {
      registerCodexReviewer(rootServices);
      registerClaudeImpl(rootServices);

      const codexServices = createServices(
        fixture.context.withActor({
          agentId: "agent_codex",
          name: "loki",
          runtime: "codex",
          role: "reviewer"
        })
      );

      codexServices.conversations.ask({
        conversationId: "conv_ask",
        messageId: "msg_ask",
        assignmentId: "assign_ask",
        target: "musashi",
        body: "Please implement the open review findings.",
        taskId: "task_ask"
      });

      const projections = fixture.context.projections();

      expect(eventTypes(fixture)).toEqual(
        expect.arrayContaining(["conversation.opened", "message.sent", "assignment.created"])
      );
      expect(projections.conversations.threads).toHaveLength(1);
      expect(projections.conversations.messages).toHaveLength(1);
      expect(projections.tasks.assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "assign_ask",
            taskId: "task_ask",
            target: {
              kind: "agent",
              name: "musashi"
            }
          })
        ])
      );
      expect(getInboxForAgentName(projections.inbox, projections.agents, "musashi")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "Please implement the open review findings.",
            status: "queued"
          })
        ])
      );
    } finally {
      fixture.store.close();
    }
  });

  it("replyToThread appends a message in the same thread and routes to the other agent", () => {
    const fixture = openFixture();
    const rootServices = createServices(fixture.context);

    try {
      registerCodexReviewer(rootServices);
      registerClaudeImpl(rootServices);

      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_reply",
        messageId: "msg_question",
        target: "musashi",
        body: "Can you fix the cleanup path?"
      });
      createServices(claudeContext(fixture)).conversations.replyToThread({
        conversationId: "conv_reply",
        messageId: "msg_answer",
        body: "I fixed it and recorded verification."
      });

      const projections = fixture.context.projections();

      expect(
        messagesForThread(projections.conversations, "conv_reply").map((message) => message.id)
      ).toEqual(["msg_question", "msg_answer"]);
      expect(eventTypes(fixture)).toContain("conversation.message_routed");
      expect(getInboxForAgentName(projections.inbox, projections.agents, "loki")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "I fixed it and recorded verification.",
            target: {
              kind: "agent",
              name: "loki"
            }
          })
        ])
      );
    } finally {
      fixture.store.close();
    }
  });

  it("replyToThread records an unrouted reply when the original sender is system", () => {
    const fixture = openFixture();
    const rootServices = createServices(fixture.context);

    try {
      registerCodexReviewer(rootServices);

      rootServices.conversations.ask({
        conversationId: "conv_system_reply",
        messageId: "msg_question",
        target: "loki",
        body: "Reply exactly PONG"
      });
      createServices(codexContext(fixture)).conversations.replyToThread({
        conversationId: "conv_system_reply",
        messageId: "msg_answer",
        body: "PONG"
      });

      const projections = fixture.context.projections();
      const messages = messagesForThread(projections.conversations, "conv_system_reply");

      expect(messages.map((message) => message.id)).toEqual(["msg_question", "msg_answer"]);
      expect(messages.at(-1)).toMatchObject({
        body: "PONG",
        recipients: []
      });
      expect(
        getInboxForAgentName(projections.inbox, projections.agents, "loki").filter(
          (item) => item.body === "PONG"
        )
      ).toEqual([]);
    } finally {
      fixture.store.close();
    }
  });

  it("recordClaim appends implementation claim and can trigger a review request", () => {
    const fixture = openFixture();
    const rootServices = createServices(fixture.context);

    try {
      registerCodexReviewer(rootServices);
      registerClaudeImpl(rootServices);

      createServices(claudeContext(fixture)).implementation.recordClaim({
        id: "claim_review",
        conversationId: "conv_claim",
        taskId: "task_review",
        summary: "Implemented command services.",
        files: ["src/services/index.ts"],
        verificationExpectation: "pnpm test",
        requestReview: {
          reviewer: "loki",
          scope: "Review command service implementation."
        }
      });

      const projections = fixture.context.projections();

      expect(eventTypes(fixture)).toEqual(
        expect.arrayContaining([
          "implementation.claim_recorded",
          "review.requested",
          "message.sent"
        ])
      );
      expect(projections.claims.claims).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "claim_review",
            verificationExpectation: "pnpm test"
          })
        ])
      );
      expect(projections.reviews.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            implementationClaimId: "claim_review",
            target: {
              kind: "agent",
              name: "loki"
            }
          })
        ])
      );
    } finally {
      fixture.store.close();
    }
  });

  it("review lifecycle commands append distinct lifecycle events", () => {
    const fixture = openFixture();
    const rootServices = createServices(fixture.context);

    try {
      registerCodexReviewer(rootServices);
      registerClaudeImpl(rootServices);

      const reviews = createServices(codexContext(fixture)).reviews;

      reviews.requestReview({
        id: "request_lifecycle",
        conversationId: "conv_review",
        implementationClaimId: "claim_lifecycle",
        reviewer: "loki",
        scope: "Review lifecycle"
      });
      reviews.recordFinding({
        id: "finding_lifecycle",
        conversationId: "conv_review",
        reviewRequestId: "request_lifecycle",
        implementationClaimId: "claim_lifecycle",
        summary: "Missing cleanup path",
        assignee: "musashi"
      });
      createServices(claudeContext(fixture)).reviews.addressFinding({
        reviewFindingId: "finding_lifecycle",
        conversationId: "conv_review",
        reviewRequestId: "request_lifecycle",
        implementationClaimId: "claim_lifecycle",
        reviewer: "loki"
      });
      reviews.acceptFinding({
        reviewFindingId: "finding_lifecycle",
        reviewRequestId: "request_lifecycle"
      });
      reviews.reopenFinding({
        reviewFindingId: "finding_lifecycle",
        reviewRequestId: "request_lifecycle"
      });
      reviews.approveReview({
        reviewRequestId: "request_lifecycle",
        implementationClaimId: "claim_lifecycle"
      });

      expect(eventTypes(fixture)).toEqual(
        expect.arrayContaining([
          "review.requested",
          "review.finding_recorded",
          "review.finding_addressed",
          "review.finding_accepted",
          "review.finding_reopened",
          "review.approved"
        ])
      );
    } finally {
      fixture.store.close();
    }
  });

  it("inbox lifecycle commands distinguish queued, claimed, delivered, failed, and read", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);

      services.messages.send({
        conversationId: "conv_queued",
        recipients: ["loki"],
        body: "queued"
      });
      services.messages.send({
        conversationId: "conv_claimed",
        recipients: ["loki"],
        body: "claimed"
      });
      services.messages.send({
        conversationId: "conv_delivered",
        recipients: ["loki"],
        body: "delivered"
      });
      services.messages.send({
        conversationId: "conv_failed",
        recipients: ["loki"],
        body: "failed"
      });
      services.messages.send({
        conversationId: "conv_read",
        recipients: ["loki"],
        body: "read"
      });

      const firstInbox = fixture.context.projections().inbox.items;
      const claimed = itemByBody(firstInbox, "claimed");
      const delivered = itemByBody(firstInbox, "delivered");
      const failed = itemByBody(firstInbox, "failed");
      const read = itemByBody(firstInbox, "read");

      services.messages.claimInboxItem({
        inboxItemId: claimed.id,
        sessionId: "sess_codex"
      });
      const deliveredAttempt = services.messages.recordDeliveryAttempt({
        inboxItemId: delivered.id,
        messageId: delivered.messageId ?? "missing-message",
        recipient: delivered.target,
        deliveryMode: "turn"
      });
      services.messages.recordDeliveryDelivered({
        id: deliveredAttempt.target.deliveryAttemptId ?? "missing-delivery",
        inboxItemId: delivered.id,
        messageId: delivered.messageId ?? "missing-message",
        recipient: delivered.target,
        deliveryMode: "turn"
      });
      const failedAttempt = services.messages.recordDeliveryAttempt({
        inboxItemId: failed.id,
        messageId: failed.messageId ?? "missing-message",
        recipient: failed.target,
        deliveryMode: "turn"
      });
      services.messages.recordDeliveryFailed({
        id: failedAttempt.target.deliveryAttemptId ?? "missing-delivery",
        inboxItemId: failed.id,
        messageId: failed.messageId ?? "missing-message",
        recipient: failed.target,
        deliveryMode: "turn",
        error: "No receiver"
      });
      services.messages.markRead({
        inboxItemId: read.id
      });

      expect(
        fixture.context
          .projections()
          .inbox.items.map((item) => item.status)
          .sort()
      ).toEqual(["claimed", "delivered", "failed", "queued", "read"]);
    } finally {
      fixture.store.close();
    }
  });

  it("dismissInboxItem appends inbox.item_dismissed with the target item and reason", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);

      services.messages.send({
        conversationId: "conv_dismiss",
        recipients: ["loki"],
        body: "stale"
      });

      const item = itemByBody(fixture.context.projections().inbox.items, "stale");
      const dismissed = services.messages.dismissInboxItem({
        inboxItemId: item.id,
        reason: "manual inbox cleanup"
      });

      expect(dismissed.type).toBe("inbox.item_dismissed");
      expect(dismissed.target.inboxItemId).toBe(item.id);
      expect(dismissed.payload).toMatchObject({ reason: "manual inbox cleanup" });
      expect(eventTypes(fixture)).toContain("inbox.item_dismissed");
    } finally {
      fixture.store.close();
    }
  });

  it("dismissInboxItem omits an empty payload when no reason is given", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);

      services.messages.send({
        conversationId: "conv_dismiss_noreason",
        recipients: ["loki"],
        body: "stale"
      });

      const item = itemByBody(fixture.context.projections().inbox.items, "stale");
      const dismissed = services.messages.dismissInboxItem({ inboxItemId: item.id });

      expect(dismissed.type).toBe("inbox.item_dismissed");
      expect(dismissed.target.inboxItemId).toBe(item.id);
      expect(dismissed.payload).toEqual({});
    } finally {
      fixture.store.close();
    }
  });

  it("automatic review loop events produce conversation and inbox state", () => {
    const fixture = openFixture();
    const rootServices = createServices(fixture.context);

    try {
      registerCodexReviewer(rootServices);
      registerClaudeImpl(rootServices);

      createServices(claudeContext(fixture)).implementation.recordClaim({
        id: "claim_loop",
        conversationId: "conv_loop",
        taskId: "task_loop",
        summary: "Implemented loop.",
        files: ["src/services/review-service.ts"],
        requestReview: {
          reviewer: "loki",
          scope: "Review loop implementation."
        }
      });
      createServices(codexContext(fixture)).reviews.recordFinding({
        id: "finding_loop",
        conversationId: "conv_loop",
        reviewRequestId: "request_loop",
        implementationClaimId: "claim_loop",
        taskId: "task_loop",
        summary: "Missing cleanup path",
        assignee: "musashi"
      });
      createServices(claudeContext(fixture)).reviews.addressFinding({
        reviewFindingId: "finding_loop",
        conversationId: "conv_loop",
        reviewRequestId: "request_loop",
        implementationClaimId: "claim_loop",
        taskId: "task_loop",
        reviewer: "loki"
      });
      createServices(codexContext(fixture)).verification.record({
        id: "vr_loop",
        conversationId: "conv_loop",
        implementationClaimId: "claim_loop",
        taskId: "task_loop",
        status: "failed",
        summary: "Verification failed after review."
      });

      const projections = fixture.context.projections();

      expect(
        messagesForThread(projections.conversations, "conv_loop").length
      ).toBeGreaterThanOrEqual(3);
      expect(getInboxForAgentName(projections.inbox, projections.agents, "loki")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "Review loop implementation."
          }),
          expect.objectContaining({
            reason: "review_finding_rereview"
          })
        ])
      );
      expect(getInboxForAgentName(projections.inbox, projections.agents, "musashi")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "Missing cleanup path"
          }),
          expect.objectContaining({
            body: "Verification failed after review."
          })
        ])
      );
    } finally {
      fixture.store.close();
    }
  });
});

interface Fixture {
  store: SqliteStore;
  eventStore: EventStore;
  context: ServiceContext;
}

function openFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "tachikoma-services-"));
  tempRoots.push(root);
  const store = SqliteStore.open(join(root, "tachikoma.sqlite"));
  const eventStore = new EventStore(store.db);
  const clock = createClock();
  const idGenerator = createIdGenerator();
  const context = new ServiceContext({
    project: {
      id: "proj_test",
      name: "tachikoma"
    },
    eventStore,
    clock,
    idGenerator
  });

  return {
    store,
    eventStore,
    context
  };
}

function registerCodexReviewer(services: ReturnType<typeof createServices>): void {
  services.agents.registerEndpoint({
    id: "agent_codex",
    name: "loki",
    runtime: "codex",
    role: "reviewer"
  });
}

function registerClaudeImpl(services: ReturnType<typeof createServices>): void {
  services.agents.registerEndpoint({
    id: "agent_claude",
    name: "musashi",
    runtime: "claude",
    role: "implementer"
  });
}

function codexContext(fixture: Fixture): ServiceContext {
  return fixture.context.withActor({
    agentId: "agent_codex",
    name: "loki",
    runtime: "codex",
    role: "reviewer"
  });
}

function claudeContext(fixture: Fixture): ServiceContext {
  return fixture.context.withActor({
    agentId: "agent_claude",
    name: "musashi",
    runtime: "claude",
    role: "implementer"
  });
}

function eventTypes(fixture: Fixture): string[] {
  return fixture.eventStore.listForward("proj_test").map((event) => event.type);
}

function itemByBody(items: InboxProjectionItem[], body: string): InboxProjectionItem {
  const item = items.find((candidate) => candidate.body === body);

  if (!item) {
    throw new Error(`Inbox item with body ${body} was not found.`);
  }

  return item;
}

function createClock(): () => string {
  let second = 0;
  return () => {
    second += 1;
    return `2026-06-01T00:00:${String(second).padStart(2, "0")}.000Z`;
  };
}

function createIdGenerator(): (prefix: string) => string {
  const counters = new Map<string, number>();

  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}
