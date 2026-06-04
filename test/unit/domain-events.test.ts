import { describe, expect, it } from "vitest";

import { createEvent, eventEnvelopeSchema } from "../../src/domain/events.js";
import { isPrefixedId } from "../../src/domain/ids.js";

const invalidRuntimeInput = {
  projectId: "proj_test",
  type: "message.sent",
  actor: {
    runtime: "unknown-runtime"
  },
  target: {},
  payload: {}
} as unknown as Parameters<typeof createEvent>[0];

describe("domain event protocol", () => {
  it("creates opaque canonical events with defaults", () => {
    const event = createEvent(
      {
        projectId: "proj_test",
        type: "message.sent",
        actor: {
          name: "loki",
          runtime: "codex",
          role: "reviewer"
        },
        target: {
          conversationId: "conv_test",
          messageId: "msg_test"
        },
        payload: {
          sender: {
            kind: "agent",
            name: "loki",
            runtime: "codex",
            role: "reviewer"
          },
          recipients: [
            {
              kind: "agent",
              name: "musashi"
            }
          ],
          body: "Please review the current diff.",
          replyPolicy: "required",
          linkedRecords: [
            {
              kind: "review_request",
              id: "request_test"
            }
          ]
        }
      },
      "2026-06-01T00:00:00.000Z"
    );

    expect(isPrefixedId(event.id, "evt")).toBe(true);
    expect(event.schemaVersion).toBe(1);
    expect(event.createdAt).toBe("2026-06-01T00:00:00.000Z");
    expect(event.payload).toEqual({
      sender: {
        kind: "agent",
        name: "loki",
        runtime: "codex",
        role: "reviewer"
      },
      recipients: [
        {
          kind: "agent",
          name: "musashi"
        }
      ],
      body: "Please review the current diff.",
      replyPolicy: "required",
      linkedRecords: [
        {
          kind: "review_request",
          id: "request_test"
        }
      ]
    });
  });

  it("allows conversation messages without routed recipients", () => {
    const event = createEvent(
      {
        projectId: "proj_test",
        type: "message.sent",
        target: {
          conversationId: "conv_test",
          messageId: "msg_reply"
        },
        payload: {
          sender: {
            kind: "agent",
            name: "triton"
          },
          recipients: [],
          body: "PONG",
          replyPolicy: "none"
        }
      },
      "2026-06-01T00:00:00.000Z"
    );

    expect(event.payload).toMatchObject({
      recipients: [],
      body: "PONG",
      replyPolicy: "none"
    });
  });

  it("rejects invalid event payload shape", () => {
    expect(() =>
      eventEnvelopeSchema.parse({
        id: "evt_invalid",
        projectId: "proj_test",
        type: "not.a_real_event",
        schemaVersion: 1,
        actor: {},
        target: {},
        payload: {},
        createdAt: "2026-06-01T00:00:00.000Z"
      })
    ).toThrow();

    expect(() => createEvent(invalidRuntimeInput)).toThrow();
    expect(() =>
      createEvent({
        projectId: "proj_test",
        type: "message.sent",
        target: {
          conversationId: "conv_test",
          messageId: "msg_test"
        },
        payload: {
          body: "missing sender and recipients"
        }
      })
    ).toThrow();
  });

  it("requires conversation events to carry structured routing links", () => {
    expect(() =>
      createEvent({
        projectId: "proj_test",
        type: "message.sent",
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
          body: "Missing conversation and message ids."
        }
      })
    ).toThrow();

    expect(() =>
      createEvent({
        projectId: "proj_test",
        type: "message.sent",
        target: {
          conversationId: "conv_test",
          messageId: "msg_test"
        },
        payload: {
          sender: {
            kind: "system"
          },
          recipients: [
            {
              kind: "agent"
            }
          ],
          body: "Missing exact agent name."
        }
      })
    ).toThrow();
  });

  it("validates structured record events that participate in conversations", () => {
    const claim = createEvent({
      projectId: "proj_test",
      type: "implementation.claim_recorded",
      target: {
        taskId: "task_test",
        assignmentId: "assign_test",
        conversationId: "conv_test",
        implementationClaimId: "claim_test"
      },
      payload: {
        summary: "Implemented the review loop.",
        files: ["src/services/review-service.ts"],
        addressedFindingIds: ["finding_test"],
        verificationExpectation: "pnpm test must pass"
      }
    });

    const reviewRequest = createEvent({
      projectId: "proj_test",
      type: "review.requested",
      target: {
        taskId: "task_test",
        conversationId: "conv_test",
        implementationClaimId: "claim_test",
        reviewRequestId: "request_test"
      },
      payload: {
        reviewer: {
          kind: "runtime-role",
          runtime: "codex",
          role: "reviewer"
        },
        scope: "current implementation claim"
      }
    });

    expect(claim.target.implementationClaimId).toBe("claim_test");
    expect(reviewRequest.target.implementationClaimId).toBe("claim_test");
    expect(reviewRequest.payload).toMatchObject({
      reviewer: {
        kind: "runtime-role",
        runtime: "codex",
        role: "reviewer"
      }
    });
  });
});
