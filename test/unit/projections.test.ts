import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type CreateEventInput, createEvent } from "../../src/domain/events.js";
import {
  agentsProjection,
  buildBriefProjectionState,
  coreProjections,
  getInboxForAgentName,
  getInboxForSession,
  getProjectionOffset,
  inboxProjection,
  rebuildProjection,
  resolveRoutingTarget,
  runProjection,
  runProjectionSet,
  saveProjectionOffset
} from "../../src/projections/index.js";
import { EventStore } from "../../src/store/event-store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("projection engine and read models", () => {
  it("rebuilds deterministic projection state from the same event log", () => {
    const events = baseConversationEvents();

    expect(runProjectionSet(coreProjections, events)).toEqual(
      runProjectionSet(coreProjections, events)
    );
  });

  it("tracks projection offsets after full rebuild from the event store", () => {
    const store = openTempStore();
    const eventStore = new EventStore(store.db);
    const events = baseConversationEvents();

    try {
      eventStore.appendBatch(events);

      const result = rebuildProjection(eventStore, "proj_test", inboxProjection);
      expect(result.lastEventId).toBe("evt_presence");
      if (!result.lastEventId) {
        throw new Error("projection rebuild did not process any events");
      }

      saveProjectionOffset(store.db, result.projectionName, result.lastEventId, fixedTime(59));

      expect(getProjectionOffset(store.db, "inbox")).toEqual({
        projectionName: "inbox",
        eventId: "evt_presence",
        updatedAt: fixedTime(59)
      });
    } finally {
      store.close();
    }
  });

  it("shows offline named inbox work to the matching session after start", () => {
    const events = baseConversationEvents();
    const agents = runProjection(agentsProjection, events).state;
    const inbox = runProjection(inboxProjection, events).state;

    const items = getInboxForSession(inbox, agents, "sess_claude");

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: "queued",
      target: {
        kind: "agent",
        name: "musashi"
      },
      body: "Please implement the open review findings."
    });
  });

  it("does not count ended sessions with stale presence as live memory", () => {
    const projections = runProjectionSet(coreProjections, [
      ...baseConversationEvents(),
      event(
        {
          id: "evt_session_ended",
          projectId: "proj_test",
          type: "session.ended",
          target: {
            sessionId: "sess_claude"
          },
          payload: {}
        },
        6
      )
    ]);
    const brief = buildBriefProjectionState({
      projectState: projections["project-state"]?.state,
      agents: projections.agents?.state,
      inbox: projections.inbox?.state,
      tasks: projections.tasks?.state,
      claims: projections.claims?.state,
      reviews: projections.reviews?.state,
      verification: projections.verification?.state,
      conversations: projections.conversations?.state
    } as Parameters<typeof buildBriefProjectionState>[0]);

    expect(brief.liveAgentCount).toBe(0);
    expect(brief.lines).toContain("Agents live: 0");
  });

  it("surfaces ambiguous role routing instead of silently choosing a target", () => {
    const agents = runProjection(agentsProjection, [
      event(
        {
          id: "evt_reviewer_a",
          projectId: "proj_test",
          type: "agent.endpoint_registered",
          target: {
            agentId: "agent_reviewer_a"
          },
          payload: {
            name: "loki-a",
            runtime: "codex",
            role: "reviewer"
          }
        },
        1
      ),
      event(
        {
          id: "evt_reviewer_b",
          projectId: "proj_test",
          type: "agent.endpoint_registered",
          target: {
            agentId: "agent_reviewer_b"
          },
          payload: {
            name: "loki-b",
            runtime: "codex",
            role: "reviewer"
          }
        },
        2
      )
    ]).state;

    const resolution = resolveRoutingTarget(agents, {
      kind: "role",
      role: "reviewer"
    });

    expect(resolution).toMatchObject({
      status: "ambiguous"
    });

    if (resolution.status === "ambiguous") {
      expect(resolution.candidates.map((candidate) => candidate.name)).toEqual([
        "loki-a",
        "loki-b"
      ]);
    }
  });

  it("keeps role-less agents out of role routing candidates", () => {
    const agents = runProjection(agentsProjection, [
      event(
        {
          id: "evt_roleless",
          projectId: "proj_test",
          type: "agent.endpoint_registered",
          target: {
            agentId: "agent_roleless"
          },
          payload: {
            name: "musashi",
            runtime: "claude"
          }
        },
        1
      ),
      event(
        {
          id: "evt_reviewer",
          projectId: "proj_test",
          type: "agent.endpoint_registered",
          target: {
            agentId: "agent_reviewer"
          },
          payload: {
            name: "loki",
            runtime: "codex",
            role: "reviewer"
          }
        },
        2
      )
    ]).state;

    expect(resolveRoutingTarget(agents, { kind: "agent", name: "musashi" })).toMatchObject({
      status: "resolved"
    });
    expect(resolveRoutingTarget(agents, { kind: "role", role: "reviewer" })).toMatchObject({
      status: "resolved",
      endpoint: {
        name: "loki"
      }
    });
    expect(resolveRoutingTarget(agents, { kind: "role", role: "implementer" })).toMatchObject({
      status: "role-inbox"
    });
  });

  it("projects structured review loop events into the right agent inboxes", () => {
    const events = [
      registerAgent("agent_claude", "musashi", "claude", "implementer", 1),
      registerAgent("agent_codex", "loki", "codex", "reviewer", 2),
      event(
        {
          id: "evt_claim",
          projectId: "proj_test",
          type: "implementation.claim_recorded",
          target: {
            taskId: "task_review",
            conversationId: "conv_review",
            implementationClaimId: "claim_review"
          },
          payload: {
            summary: "Implemented the review loop.",
            files: ["src/services/review-service.ts"],
            verificationExpectation: "pnpm test"
          }
        },
        3
      ),
      event(
        {
          id: "evt_finding",
          projectId: "proj_test",
          type: "review.finding_recorded",
          target: {
            taskId: "task_review",
            conversationId: "conv_review",
            implementationClaimId: "claim_review",
            reviewRequestId: "request_review",
            reviewFindingId: "finding_review"
          },
          payload: {
            summary: "Missing cleanup path"
          }
        },
        4
      ),
      event(
        {
          id: "evt_finding_addressed",
          projectId: "proj_test",
          type: "review.finding_addressed",
          target: {
            taskId: "task_review",
            conversationId: "conv_review",
            implementationClaimId: "claim_review",
            reviewRequestId: "request_review",
            reviewFindingId: "finding_review"
          },
          payload: {}
        },
        5
      )
    ];
    const agents = runProjection(agentsProjection, events).state;
    const inbox = runProjection(inboxProjection, events).state;

    expect(getInboxForAgentName(inbox, agents, "loki")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "implementation_claim_review",
          target: {
            kind: "role",
            role: "reviewer"
          }
        }),
        expect.objectContaining({
          reason: "review_finding_rereview",
          target: {
            kind: "role",
            role: "reviewer"
          }
        })
      ])
    );

    expect(getInboxForAgentName(inbox, agents, "musashi")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "review_finding_address",
          target: {
            kind: "role",
            role: "implementer"
          }
        })
      ])
    );
  });

  it("keeps inbox lifecycle states distinguishable", () => {
    const events = [
      ...messageFor("queued", 1),
      ...messageFor("claimed", 2),
      event(
        {
          id: "evt_claimed_update",
          projectId: "proj_test",
          type: "inbox.item_claimed",
          target: {
            inboxItemId: "inbox_evt_claimed_message_0"
          },
          payload: {
            sessionId: "sess_codex"
          }
        },
        3
      ),
      ...messageFor("delivered", 4),
      deliveryEvent("evt_delivered_delivery", "delivered", "delivered", 5),
      ...messageFor("failed", 6),
      deliveryEvent("evt_failed_delivery", "failed", "failed", 7),
      ...messageFor("read", 8),
      event(
        {
          id: "evt_read_update",
          projectId: "proj_test",
          type: "message.read",
          target: {
            inboxItemId: "inbox_evt_read_message_0"
          },
          payload: {}
        },
        9
      )
    ];

    const inbox = runProjection(inboxProjection, events).state;

    expect(inbox.items.map((item) => item.status).sort()).toEqual([
      "claimed",
      "delivered",
      "failed",
      "queued",
      "read"
    ]);
    expect(inbox.deliveryAttempts.map((attempt) => attempt.status).sort()).toEqual([
      "delivered",
      "failed"
    ]);
  });

  it("dismisses an inbox item to cancelled and keeps it terminal against later delivery", () => {
    const baseEvents = [
      registerAgent("agent_codex", "loki", "codex", "reviewer", 1),
      ...messageFor("stale", 2),
      event(
        {
          id: "evt_stale_dismissed",
          projectId: "proj_test",
          type: "inbox.item_dismissed",
          target: {
            inboxItemId: "inbox_evt_stale_message_0"
          },
          payload: {
            reason: "manual inbox cleanup"
          }
        },
        3
      )
    ];

    const afterDismiss = runProjection(inboxProjection, baseEvents).state;
    const agents = runProjection(agentsProjection, baseEvents).state;
    const dismissedItem = afterDismiss.items.find(
      (item) => item.id === "inbox_evt_stale_message_0"
    );

    expect(dismissedItem).toMatchObject({
      status: "cancelled",
      dismissedAt: fixedTime(3),
      dismissedReason: "manual inbox cleanup"
    });
    expect(getInboxForAgentName(afterDismiss, agents, "loki")).toEqual([]);

    const afterDelivery = runProjection(inboxProjection, [
      ...baseEvents,
      deliveryEvent("evt_stale_delivered", "stale", "delivered", 4),
      deliveryEvent("evt_stale_failed", "stale", "failed", 5)
    ]).state;

    expect(
      afterDelivery.items.find((item) => item.id === "inbox_evt_stale_message_0")?.status
    ).toBe("cancelled");
  });
});

function baseConversationEvents() {
  return [
    event(
      {
        id: "evt_project",
        projectId: "proj_test",
        type: "project.initialized",
        payload: {
          name: "tachikoma"
        }
      },
      1
    ),
    registerAgent("agent_claude", "musashi", "claude", "implementer", 2),
    event(
      {
        id: "evt_message",
        projectId: "proj_test",
        type: "message.sent",
        target: {
          conversationId: "conv_work",
          messageId: "msg_work"
        },
        payload: {
          sender: {
            kind: "system"
          },
          recipients: [
            {
              kind: "agent",
              name: "musashi"
            }
          ],
          body: "Please implement the open review findings.",
          replyPolicy: "required"
        }
      },
      3
    ),
    event(
      {
        id: "evt_session",
        projectId: "proj_test",
        type: "session.started",
        target: {
          agentId: "agent_claude",
          sessionId: "sess_claude"
        },
        payload: {
          runtime: "claude",
          role: "implementer",
          deliveryMode: "turn"
        }
      },
      4
    ),
    event(
      {
        id: "evt_presence",
        projectId: "proj_test",
        type: "agent.presence_announced",
        target: {
          agentId: "agent_claude",
          sessionId: "sess_claude",
          presenceId: "presence_claude"
        },
        payload: {
          deliveryMode: "turn",
          capabilities: ["inbox"]
        }
      },
      5
    )
  ];
}

function registerAgent(
  agentId: string,
  name: string,
  runtime: "codex" | "claude",
  role: "implementer" | "reviewer",
  second: number
) {
  return event(
    {
      id: `evt_register_${agentId}`,
      projectId: "proj_test",
      type: "agent.endpoint_registered",
      target: {
        agentId
      },
      payload: {
        name,
        runtime,
        role
      }
    },
    second
  );
}

function messageFor(label: string, second: number) {
  return [
    event(
      {
        id: `evt_${label}_message`,
        projectId: "proj_test",
        type: "message.sent",
        target: {
          conversationId: `conv_${label}`,
          messageId: `msg_${label}`
        },
        payload: {
          sender: {
            kind: "system"
          },
          recipients: [
            {
              kind: "agent",
              name: "loki"
            }
          ],
          body: label,
          replyPolicy: "required"
        }
      },
      second
    )
  ];
}

function deliveryEvent(id: string, label: string, status: "delivered" | "failed", second: number) {
  const payload =
    status === "failed"
      ? {
          deliveryMode: "turn",
          recipient: {
            kind: "agent",
            name: "loki"
          },
          error: "delivery failed"
        }
      : {
          deliveryMode: "turn",
          recipient: {
            kind: "agent",
            name: "loki"
          },
          outcome: "replied"
        };

  return event(
    {
      id,
      projectId: "proj_test",
      type: status === "delivered" ? "delivery.delivered" : "delivery.failed",
      target: {
        deliveryAttemptId: `delivery_${label}`,
        inboxItemId: `inbox_evt_${label}_message_0`,
        messageId: `msg_${label}`
      },
      payload
    },
    second
  );
}

function event(input: CreateEventInput, second: number) {
  return createEvent(input, fixedTime(second));
}

function fixedTime(second: number): string {
  return `2026-06-01T00:00:${String(second).padStart(2, "0")}.000Z`;
}

function openTempStore(): SqliteStore {
  const root = mkdtempSync(join(tmpdir(), "tachikoma-projections-"));
  tempRoots.push(root);
  return SqliteStore.open(join(root, "tachikoma.sqlite"));
}
