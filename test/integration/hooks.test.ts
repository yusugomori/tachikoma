import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  recordPendingHostSessionBinding,
  resolveBoundHostAgentName,
  runMonitorHook,
  runMonitorWatch,
  runReceiveHook,
  runSessionStartHook,
  runStopHook
} from "../../src/adapters/index.js";
import { createServices, ServiceContext, type Services } from "../../src/services/index.js";
import { EventStore } from "../../src/store/event-store.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

const TACHIKOMA_IDENTITY_ENV_KEYS = [
  "TACHIKOMA_AGENT_NAME",
  "TACHIKOMA_ACTOR_NAME",
  "TACHIKOMA_RUNTIME",
  "TACHIKOMA_ACTOR_RUNTIME",
  "TACHIKOMA_SESSION_ID",
  "TACHIKOMA_ACTOR_SESSION",
  "TACHIKOMA_ROLE",
  "TACHIKOMA_ACTOR_ROLE"
] as const;

const tempRoots: string[] = [];
const isolatedEnv = snapshotTachikomaIdentityEnv();

beforeEach(() => {
  clearTachikomaIdentityEnv();
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }

  restoreTachikomaIdentityEnv(isolatedEnv);
});

describe("hook adapters", () => {
  it("SessionStart hook starts a session and returns compact memory output", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.project.initialize({ name: "Hooks" });
      registerClaudeImpl(services);

      const result = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "turn"
      });

      expect(result.output).toContain("Tachikoma session: sess_1");
      expect(result.output).toContain("Delivery mode: turn");
      expect(result.output).toContain("Project: Hooks");
      expect(result.output).toContain("Pending inbox:");
      expect(eventTypes(fixture)).toEqual(
        expect.arrayContaining(["session.started", "agent.presence_announced"])
      );
    } finally {
      fixture.store.close();
    }
  });

  it("binds bare tachikoma boot prompts from pending launcher state", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.agents.registerEndpoint({
        id: "agent_claude_01",
        name: "claude-01",
        runtime: "claude"
      });
      const session = runSessionStartHook(fixture.context, services, {
        name: "claude-01",
        deliveryMode: "both"
      });

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "claude",
        agentName: "claude-01",
        tachikomaSessionId: session.sessionId,
        source: "test-launcher"
      });

      const resolved = resolveBoundHostAgentName(fixture.context, {
        runtime: "claude",
        eventName: "UserPromptSubmit",
        sessionId: "host_claude_session",
        raw: {
          prompt: "/tachikoma-boot"
        }
      });
      const followup = resolveBoundHostAgentName(fixture.context, {
        runtime: "claude",
        eventName: "UserPromptSubmit",
        sessionId: "host_claude_session",
        raw: {}
      });

      expect(resolved).toBe("claude-01");
      expect(followup).toBe("claude-01");
    } finally {
      fixture.store.close();
    }
  });

  it("injects launcher monitor context for bare tachikoma boot prompts without inbox work", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.agents.registerEndpoint({
        id: "agent_claude_01",
        name: "claude-01",
        runtime: "claude"
      });
      const session = runSessionStartHook(fixture.context, services, {
        name: "claude-01",
        deliveryMode: "both"
      });
      const host = {
        runtime: "claude" as const,
        eventName: "UserPromptSubmit",
        sessionId: "host_claude_session",
        raw: {
          prompt: "/tachikoma-boot"
        }
      };

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "claude",
        agentName: "claude-01",
        tachikomaSessionId: session.sessionId,
        source: "test-launcher"
      });

      const agentName = resolveBoundHostAgentName(fixture.context, host);
      const result = runReceiveHook(fixture.context, services, {
        agentName,
        host
      });

      expect(agentName).toBe("claude-01");
      expect(result.output).toContain("Tachikoma launcher identity is already bound");
      expect(result.output).toContain("Agent: claude-01");
      expect(result.output).toContain("Do not call tachikoma_session_join");
      expect(result.output).toContain("Monitor input");
      expect(result.output).toContain("hook monitor --name claude-01 --watch");
      // The fixture root is a plain temp dir, not a tachikoma source checkout,
      // so the delivered Monitor command must invoke the global `tachikoma`
      // binary rather than `pnpm --dir <cwd>` (which fails without a manifest).
      expect(result.output).toContain("tachikoma --cwd");
      expect(result.output).not.toContain("pnpm --dir");
    } finally {
      fixture.store.close();
    }
  });

  it("delivers pending directives before launcher identity context for tachikoma prompts", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "both"
      });
      const host = {
        runtime: "claude" as const,
        eventName: "UserPromptSubmit",
        sessionId: "host_claude_session",
        raw: {
          prompt: "/tachikoma"
        }
      };

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "claude",
        agentName: "musashi",
        tachikomaSessionId: session.sessionId,
        source: "test-launcher"
      });
      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_identity_precedence",
        messageId: "msg_identity_precedence",
        target: "musashi",
        body: "Pending directive should be delivered first."
      });

      const agentName = resolveBoundHostAgentName(fixture.context, host);
      const result = runReceiveHook(fixture.context, services, {
        agentName,
        host
      });

      expect(agentName).toBe("musashi");
      expect(result.output).toContain("Tachikoma delivered 1 message(s) for musashi.");
      expect(result.output).toContain("Pending directive should be delivered first.");
      expect(result.output).not.toContain("launcher identity is already bound");
    } finally {
      fixture.store.close();
    }
  });

  it("claims pending Codex launcher binding for a new host session", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.agents.registerEndpoint({
        id: "agent_codex_01",
        name: "codex-01",
        runtime: "codex"
      });
      const session = runSessionStartHook(fixture.context, services, {
        name: "codex-01",
        deliveryMode: "realtime"
      });

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "codex",
        agentName: "codex-01",
        tachikomaSessionId: session.sessionId,
        source: "test-launcher"
      });

      const resolved = resolveBoundHostAgentName(fixture.context, {
        runtime: "codex",
        eventName: "UserPromptSubmit",
        sessionId: "host_codex_session",
        raw: {
          prompt: "$tachikoma 名前教えて"
        }
      });
      const followup = resolveBoundHostAgentName(fixture.context, {
        runtime: "codex",
        eventName: "UserPromptSubmit",
        sessionId: "host_codex_session",
        raw: {}
      });

      expect(resolved).toBe("codex-01");
      expect(followup).toBe("codex-01");
    } finally {
      fixture.store.close();
    }
  });

  it("keeps a bound Codex launcher identity when a tachikoma prompt names a target", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.agents.registerEndpoint({
        id: "agent_codex_01",
        name: "codex-01",
        runtime: "codex"
      });
      services.agents.registerEndpoint({
        id: "agent_codex_02",
        name: "codex-02",
        runtime: "codex"
      });
      runSessionStartHook(fixture.context, services, {
        name: "codex-01",
        deliveryMode: "realtime"
      });
      const ownSession = runSessionStartHook(fixture.context, services, {
        name: "codex-02",
        deliveryMode: "realtime"
      });

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "codex",
        agentName: "codex-02",
        tachikomaSessionId: ownSession.sessionId,
        source: "test-launcher"
      });

      const initial = resolveBoundHostAgentName(fixture.context, {
        runtime: "codex",
        eventName: "UserPromptSubmit",
        sessionId: "host_codex_02_session",
        raw: {
          prompt: "$tachikoma 君の名は？"
        }
      });
      const targetPrompt = {
        runtime: "codex" as const,
        eventName: "UserPromptSubmit",
        sessionId: "host_codex_02_session",
        raw: {
          prompt: "$tachikoma codex-01 と ping pong して"
        }
      };
      const followup = resolveBoundHostAgentName(fixture.context, targetPrompt);
      const result = runReceiveHook(fixture.context, services, {
        agentName: followup,
        host: targetPrompt
      });

      expect(initial).toBe("codex-02");
      expect(followup).toBe("codex-02");
      expect(result.output).toContain("Agent: codex-02");
      expect(result.output).toContain(`Session: ${ownSession.sessionId}`);
      expect(result.output).not.toContain("Agent: codex-01");
    } finally {
      fixture.store.close();
    }
  });

  it("injects launcher identity context for bare tachikoma Codex prompts without inbox work", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.agents.registerEndpoint({
        id: "agent_codex_01",
        name: "codex-01",
        runtime: "codex",
        role: "reviewer"
      });
      services.agents.registerEndpoint({
        id: "agent_claude_01",
        name: "claude-01",
        runtime: "claude",
        role: "implementer"
      });
      const session = runSessionStartHook(fixture.context, services, {
        name: "codex-01",
        deliveryMode: "realtime"
      });
      const host = {
        runtime: "codex" as const,
        eventName: "UserPromptSubmit",
        sessionId: "host_codex_session",
        raw: {
          prompt: "$tachikoma 名前教えて"
        }
      };

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "codex",
        agentName: "codex-01",
        tachikomaSessionId: session.sessionId,
        source: "test-launcher"
      });

      const agentName = resolveBoundHostAgentName(fixture.context, host);
      const result = runReceiveHook(fixture.context, services, {
        agentName,
        host
      });

      expect(agentName).toBe("codex-01");
      expect(result.output).toContain("Tachikoma launcher identity is already bound");
      expect(result.output).toContain("Agent: codex-01");
      expect(result.output).toContain("Runtime: codex");
      expect(result.output).toContain(`Session: ${session.sessionId}`);
      expect(result.output).toContain(
        `Reply identity: --as codex-01 --actor-runtime codex --actor-session ${session.sessionId}`
      );
      expect(result.output).not.toContain("Monitor input");

      createServices(
        fixture.context.withActor({
          agentId: "agent_codex_01",
          name: "codex-01",
          runtime: "codex",
          role: "reviewer",
          sessionId: session.sessionId
        })
      ).conversations.ask({
        conversationId: "conv_bound_codex",
        messageId: "msg_bound_codex",
        target: "claude-01",
        body: "Bound Codex should be the sender."
      });

      expect(
        fixture.context
          .projections()
          .conversations.messages.find((message) => message.id === "msg_bound_codex")?.sender
      ).toMatchObject({
        kind: "agent",
        name: "codex-01",
        runtime: "codex",
        sessionId: session.sessionId
      });
    } finally {
      fixture.store.close();
    }
  });

  it("does not guess a launcher binding when multiple pending Codex launches are live", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.agents.registerEndpoint({
        id: "agent_codex_01",
        name: "codex-01",
        runtime: "codex"
      });
      services.agents.registerEndpoint({
        id: "agent_codex_02",
        name: "codex-02",
        runtime: "codex"
      });
      const first = runSessionStartHook(fixture.context, services, {
        name: "codex-01",
        deliveryMode: "realtime"
      });
      const second = runSessionStartHook(fixture.context, services, {
        name: "codex-02",
        deliveryMode: "realtime"
      });

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "codex",
        agentName: "codex-01",
        tachikomaSessionId: first.sessionId
      });
      recordPendingHostSessionBinding(fixture.context, {
        runtime: "codex",
        agentName: "codex-02",
        tachikomaSessionId: second.sessionId
      });

      const resolved = resolveBoundHostAgentName(fixture.context, {
        runtime: "codex",
        eventName: "UserPromptSubmit",
        sessionId: "host_unknown_codex_order",
        raw: {
          prompt: "$tachikoma"
        }
      });

      expect(resolved).toBeUndefined();
    } finally {
      fixture.store.close();
    }
  });

  it("resolves Codex launcher identity from exact session environment when pending launches are ambiguous", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);
    const previousName = process.env.TACHIKOMA_AGENT_NAME;
    const previousActorName = process.env.TACHIKOMA_ACTOR_NAME;
    const previousRuntime = process.env.TACHIKOMA_RUNTIME;
    const previousActorRuntime = process.env.TACHIKOMA_ACTOR_RUNTIME;
    const previousSession = process.env.TACHIKOMA_SESSION_ID;
    const previousActorSession = process.env.TACHIKOMA_ACTOR_SESSION;

    try {
      services.agents.registerEndpoint({
        id: "agent_codex_01",
        name: "codex-01",
        runtime: "codex"
      });
      services.agents.registerEndpoint({
        id: "agent_codex_02",
        name: "codex-02",
        runtime: "codex"
      });
      const first = runSessionStartHook(fixture.context, services, {
        name: "codex-01",
        deliveryMode: "realtime"
      });
      const second = runSessionStartHook(fixture.context, services, {
        name: "codex-02",
        deliveryMode: "realtime"
      });
      const host = {
        runtime: "codex" as const,
        eventName: "UserPromptSubmit",
        sessionId: "host_codex_exact_session",
        raw: {
          prompt: "$tachikoma 君の名は？"
        }
      };

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "codex",
        agentName: "codex-01",
        tachikomaSessionId: first.sessionId
      });
      recordPendingHostSessionBinding(fixture.context, {
        runtime: "codex",
        agentName: "codex-02",
        tachikomaSessionId: second.sessionId
      });

      delete process.env.TACHIKOMA_AGENT_NAME;
      delete process.env.TACHIKOMA_ACTOR_NAME;
      delete process.env.TACHIKOMA_ACTOR_RUNTIME;
      delete process.env.TACHIKOMA_ACTOR_SESSION;
      process.env.TACHIKOMA_RUNTIME = "codex";
      process.env.TACHIKOMA_SESSION_ID = second.sessionId;

      const agentName = resolveBoundHostAgentName(fixture.context, host);
      const result = runReceiveHook(fixture.context, services, {
        agentName,
        host
      });
      const followup = resolveBoundHostAgentName(fixture.context, {
        runtime: "codex",
        eventName: "UserPromptSubmit",
        sessionId: "host_codex_exact_session",
        raw: {}
      });

      expect(agentName).toBe("codex-02");
      expect(followup).toBe("codex-02");
      expect(result.output).toContain("Agent: codex-02");
      expect(result.output).toContain(`Session: ${second.sessionId}`);
      expect(result.output).toContain(
        `Reply identity: --as codex-02 --actor-runtime codex --actor-session ${second.sessionId}`
      );
    } finally {
      restoreEnv("TACHIKOMA_AGENT_NAME", previousName);
      restoreEnv("TACHIKOMA_ACTOR_NAME", previousActorName);
      restoreEnv("TACHIKOMA_RUNTIME", previousRuntime);
      restoreEnv("TACHIKOMA_ACTOR_RUNTIME", previousActorRuntime);
      restoreEnv("TACHIKOMA_SESSION_ID", previousSession);
      restoreEnv("TACHIKOMA_ACTOR_SESSION", previousActorSession);
      fixture.store.close();
    }
  });

  it("ignores stale Codex host bindings before claiming a fresh pending launch", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.agents.registerEndpoint({
        id: "agent_codex_01",
        name: "codex-01",
        runtime: "codex"
      });
      services.agents.registerEndpoint({
        id: "agent_codex_03",
        name: "codex-03",
        runtime: "codex"
      });
      const oldSession = runSessionStartHook(fixture.context, services, {
        name: "codex-01",
        deliveryMode: "realtime"
      });
      const host = {
        runtime: "codex" as const,
        eventName: "UserPromptSubmit",
        sessionId: "host_codex_reused",
        raw: {
          prompt: "$tachikoma"
        }
      };

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "codex",
        agentName: "codex-01",
        tachikomaSessionId: oldSession.sessionId
      });
      expect(resolveBoundHostAgentName(fixture.context, host)).toBe("codex-01");

      services.sessions.end({ sessionId: oldSession.sessionId });
      const freshSession = runSessionStartHook(fixture.context, services, {
        name: "codex-03",
        deliveryMode: "realtime"
      });

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "codex",
        agentName: "codex-03",
        tachikomaSessionId: freshSession.sessionId
      });

      expect(resolveBoundHostAgentName(fixture.context, host)).toBe("codex-03");
    } finally {
      fixture.store.close();
    }
  });

  it("does not guess a launcher binding when multiple pending Claude launches are live", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.agents.registerEndpoint({
        id: "agent_claude_01",
        name: "claude-01",
        runtime: "claude"
      });
      services.agents.registerEndpoint({
        id: "agent_claude_02",
        name: "claude-02",
        runtime: "claude"
      });
      const first = runSessionStartHook(fixture.context, services, {
        name: "claude-01",
        deliveryMode: "both"
      });
      const second = runSessionStartHook(fixture.context, services, {
        name: "claude-02",
        deliveryMode: "both"
      });

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "claude",
        agentName: "claude-01",
        tachikomaSessionId: first.sessionId
      });
      recordPendingHostSessionBinding(fixture.context, {
        runtime: "claude",
        agentName: "claude-02",
        tachikomaSessionId: second.sessionId
      });

      const resolved = resolveBoundHostAgentName(fixture.context, {
        runtime: "claude",
        eventName: "UserPromptSubmit",
        sessionId: "host_unknown_order",
        raw: {
          prompt: "/tachikoma-boot"
        }
      });

      expect(resolved).toBeUndefined();
    } finally {
      fixture.store.close();
    }
  });

  it("keeps a bound Claude launcher identity when a tachikoma prompt names a target", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      services.agents.registerEndpoint({
        id: "agent_claude_01",
        name: "claude-01",
        runtime: "claude"
      });
      services.agents.registerEndpoint({
        id: "agent_claude_02",
        name: "claude-02",
        runtime: "claude"
      });
      runSessionStartHook(fixture.context, services, {
        name: "claude-01",
        deliveryMode: "both"
      });
      const ownSession = runSessionStartHook(fixture.context, services, {
        name: "claude-02",
        deliveryMode: "both"
      });

      recordPendingHostSessionBinding(fixture.context, {
        runtime: "claude",
        agentName: "claude-02",
        tachikomaSessionId: ownSession.sessionId,
        source: "test-launcher"
      });

      const initial = resolveBoundHostAgentName(fixture.context, {
        runtime: "claude",
        eventName: "UserPromptSubmit",
        sessionId: "host_claude_02_session",
        raw: {
          prompt: "/tachikoma 君の名は？"
        }
      });
      const targetPrompt = {
        runtime: "claude" as const,
        eventName: "UserPromptSubmit",
        sessionId: "host_claude_02_session",
        raw: {
          prompt: "/tachikoma claude-01 と ping pong して"
        }
      };
      const followup = resolveBoundHostAgentName(fixture.context, targetPrompt);
      const result = runReceiveHook(fixture.context, services, {
        agentName: followup,
        host: targetPrompt
      });

      expect(initial).toBe("claude-02");
      expect(followup).toBe("claude-02");
      expect(result.output).toContain("Agent: claude-02");
      expect(result.output).toContain(`Session: ${ownSession.sessionId}`);
      expect(result.output).not.toContain("Agent: claude-01");
    } finally {
      fixture.store.close();
    }
  });

  it("does not fall back to a sample name for bare tachikoma boot prompts", () => {
    const fixture = openFixture();

    try {
      const resolved = resolveBoundHostAgentName(fixture.context, {
        runtime: "claude",
        eventName: "UserPromptSubmit",
        sessionId: "host_unbound_session",
        raw: {
          prompt: "/tachikoma-boot"
        }
      });

      expect(resolved).toBeUndefined();
    } finally {
      fixture.store.close();
    }
  });

  it("Stop hook surfaces unread messages without raw transcript ingestion", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "turn"
      });

      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_stop",
        messageId: "msg_stop",
        assignmentId: "assign_stop",
        target: "musashi",
        body: "Please inspect the pending reply."
      });

      const result = runStopHook(fixture.context, services, {
        sessionId: session.sessionId,
        transcript: "RAW_TRANSCRIPT_SHOULD_NOT_APPEAR"
      } as { sessionId: string });

      expect(result.output).toContain("Tachikoma stop delivery (turn)");
      expect(result.output).toContain("Please inspect the pending reply.");
      expect(result.output).not.toContain("RAW_TRANSCRIPT_SHOULD_NOT_APPEAR");
      expect(eventTypes(fixture)).toEqual(
        expect.arrayContaining(["delivery.attempted", "delivery.delivered"])
      );
      expect(fixture.context.projections().inbox.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: "Please inspect the pending reply.",
            status: "delivered"
          })
        ])
      );
    } finally {
      fixture.store.close();
    }
  });

  it("Stop hook surfaces pending conversation replies for the active named agent", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      runSessionStartHook(fixture.context, services, {
        name: "loki",
        deliveryMode: "turn"
      });

      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_reply_delivery",
        messageId: "msg_question",
        target: "musashi",
        body: "Can you address the finding?"
      });
      createServices(claudeContext(fixture)).conversations.replyToThread({
        conversationId: "conv_reply_delivery",
        messageId: "msg_answer",
        body: "I addressed the finding."
      });

      const result = runStopHook(fixture.context, services, {
        agentName: "loki"
      });

      expect(result.output).toContain("conv_reply_delivery");
      expect(result.output).toContain("I addressed the finding.");
    } finally {
      fixture.store.close();
    }
  });

  it("delivery mode off produces no automatic delivery", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "off"
      });

      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_off",
        messageId: "msg_off",
        target: "musashi",
        body: "This should not be delivered automatically."
      });

      const result = runStopHook(fixture.context, services, {
        sessionId: session.sessionId
      });

      expect(result.output).toBe("");
      expect(eventTypes(fixture).filter((type) => type.startsWith("delivery."))).toEqual([]);
    } finally {
      fixture.store.close();
    }
  });

  it("sender-side wakeup collection does not mark delivery state", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "turn"
      });

      const events = createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_wakeup",
        messageId: "msg_wakeup",
        target: "musashi",
        body: "Wake the live recipient without delivering."
      });

      expect(services.delivery.collectWakeableRecipients(events)).toEqual([
        expect.objectContaining({
          messageId: "msg_wakeup",
          sessionIds: [session.sessionId]
        })
      ]);
      expect(eventTypes(fixture).filter((type) => type === "delivery.delivered")).toEqual([]);
      expect(fixture.context.projections().inbox.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: "msg_wakeup",
            status: "queued"
          })
        ])
      );
    } finally {
      fixture.store.close();
    }
  });

  it("receiver-side delivery is idempotent for the same inbox item", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "turn"
      });

      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_idempotent",
        messageId: "msg_idempotent",
        target: "musashi",
        body: "Deliver this once."
      });

      const first = services.delivery.deliverPending({
        sessionId: session.sessionId,
        surface: "stop"
      });
      const second = services.delivery.deliverPending({
        sessionId: session.sessionId,
        surface: "stop"
      });

      expect(first.events.map((event) => event.type)).toEqual([
        "delivery.attempted",
        "delivery.delivered"
      ]);
      expect(second.events).toEqual([]);
      expect(fixture.context.projections().inbox.deliveryAttempts).toEqual([
        expect.objectContaining({
          messageId: "msg_idempotent",
          status: "delivered"
        })
      ]);
    } finally {
      fixture.store.close();
    }
  });

  it("receive Stop hook prevents recursion when no new work remains", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "turn"
      });
      const host = {
        runtime: "codex" as const,
        eventName: "Stop",
        stopHookActive: true
      };

      const idle = runReceiveHook(fixture.context, services, {
        sessionId: session.sessionId,
        host
      });

      expect(idle.output).toBe("");
      expect(idle.hookOutput).toEqual({ kind: "noop" });

      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_receive_guard",
        messageId: "msg_receive_guard",
        target: "musashi",
        body: "Continue from this delivery.",
        replyPolicy: "optional"
      });

      const delivered = runReceiveHook(fixture.context, services, {
        sessionId: session.sessionId,
        host
      });
      const repeated = runReceiveHook(fixture.context, services, {
        sessionId: session.sessionId,
        host
      });

      expect(delivered.output).toContain('"decision":"block"');
      expect(delivered.output).toContain("Tachikoma delivered 1 message(s) for musashi.");
      expect(delivered.output).toContain("Continue from this delivery.");
      expect(repeated.output).toBe("");
      expect(repeated.hookOutput).toEqual({ kind: "noop" });
    } finally {
      fixture.store.close();
    }
  });

  it("required reply deliveries repeat until a Tachikoma reply records the inbox item read", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "turn"
      });

      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_required_reply",
        messageId: "msg_required_reply",
        target: "musashi",
        body: "Reply through Tachikoma, not just chat."
      });

      const first = runStopHook(fixture.context, services, {
        sessionId: session.sessionId
      });
      const repeated = runStopHook(fixture.context, services, {
        sessionId: session.sessionId
      });

      expect(first.output).toContain("reply_policy: required");
      expect(first.output).toContain("required_reply:");
      expect(first.output).toContain("normal chat answer alone does not satisfy");
      expect(repeated.output).toContain("[delivered]");
      expect(repeated.output).toContain("Reply through Tachikoma, not just chat.");

      createServices(claudeContext(fixture)).conversations.replyToThread({
        conversationId: "conv_required_reply",
        body: "Recorded through Tachikoma."
      });

      const afterReply = runStopHook(fixture.context, services, {
        sessionId: session.sessionId
      });

      expect(afterReply.output).toBe("");
      expect(fixture.context.projections().inbox.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: "msg_required_reply",
            status: "read"
          })
        ])
      );
    } finally {
      fixture.store.close();
    }
  });

  it("delivery mode turn checks between turns", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "turn"
      });

      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_turn",
        messageId: "msg_turn",
        target: "musashi",
        body: "Turn delivery should surface this."
      });

      const result = runStopHook(fixture.context, services, {
        sessionId: session.sessionId
      });

      expect(result.output).toContain("Turn delivery should surface this.");
      expect(result.delivery.events.map((event) => event.type)).toEqual([
        "delivery.attempted",
        "delivery.delivered"
      ]);
    } finally {
      fixture.store.close();
    }
  });

  it("Monitor hook emits delivery stream where supported", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "monitor"
      });

      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_monitor",
        messageId: "msg_monitor",
        target: "musashi",
        body: "Monitor delivery should stream this."
      });

      const stopResult = runStopHook(fixture.context, services, {
        sessionId: session.sessionId
      });
      const monitorResult = runMonitorHook(fixture.context, services, {
        sessionId: session.sessionId
      });

      expect(stopResult.output).toBe("");
      expect(monitorResult.output).toContain("Tachikoma monitor delivery (monitor)");
      expect(monitorResult.output).toContain("Monitor delivery should stream this.");
    } finally {
      fixture.store.close();
    }
  });

  it("SessionStart hook renders Claude monitor activation when joining monitor mode", () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerClaudeImpl(services);
      const result = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "monitor"
      });

      expect(result.output).toContain("Tachikoma monitor");
      expect(result.output).toContain("agent: musashi");
      expect(result.output).toContain("tachikoma hook monitor --name musashi --watch");
      expect(result.output).toContain("fallback: if Claude Monitor is unavailable");
    } finally {
      fixture.store.close();
    }
  });

  it("Monitor watch exits cleanly after idle timeout with no pending work", async () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "monitor"
      });

      const result = await runMonitorWatch(fixture.context, services, {
        sessionId: session.sessionId,
        pollMs: 1,
        idleTimeoutMs: 50
      });

      expect(result).toEqual({
        outputs: [],
        deliveredBatches: 0,
        deliveredItems: 0,
        timedOut: true,
        aborted: false
      });
    } finally {
      fixture.store.close();
    }
  });

  it("Monitor watch emits one prompt and records one delivery pair for an arriving message", async () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);
    const outputs: string[] = [];

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "monitor"
      });

      const watch = runMonitorWatch(fixture.context, services, {
        sessionId: session.sessionId,
        pollMs: 1,
        idleTimeoutMs: 50,
        onOutput: (output) => {
          outputs.push(output);
        }
      });

      setTimeout(() => {
        createServices(codexContext(fixture)).conversations.ask({
          conversationId: "conv_monitor_watch",
          messageId: "msg_monitor_watch",
          target: "musashi",
          body: "Monitor watch should deliver this once.",
          replyPolicy: "optional"
        });
      }, 1);

      const result = await watch;
      const types = eventTypes(fixture);
      const repeat = await runMonitorWatch(fixture.context, services, {
        sessionId: session.sessionId,
        pollMs: 1,
        once: true
      });

      expect(result.deliveredBatches).toBe(1);
      expect(result.deliveredItems).toBe(1);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toContain("Tachikoma delivered 1 message(s) for musashi.");
      expect(outputs[0]).toContain("Monitor watch should deliver this once.");
      expect(types.filter((type) => type === "delivery.attempted")).toHaveLength(1);
      expect(types.filter((type) => type === "delivery.delivered")).toHaveLength(1);
      expect(repeat.outputs).toEqual([]);
      expect(fixture.context.projections().inbox.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: "msg_monitor_watch",
            status: "delivered"
          })
        ])
      );
    } finally {
      fixture.store.close();
    }
  });

  it("Monitor watch keeps delivered required items outstanding without reprinting them", async () => {
    const fixture = openFixture();
    const services = createServices(fixture.context);

    try {
      registerCodexReviewer(services);
      registerClaudeImpl(services);
      const session = runSessionStartHook(fixture.context, services, {
        name: "musashi",
        deliveryMode: "monitor"
      });

      createServices(codexContext(fixture)).conversations.ask({
        conversationId: "conv_monitor_required",
        messageId: "msg_monitor_required",
        target: "musashi",
        body: "Required monitor delivery should not reprint every poll."
      });

      const first = await runMonitorWatch(fixture.context, services, {
        sessionId: session.sessionId,
        pollMs: 1,
        once: true
      });
      const second = await runMonitorWatch(fixture.context, services, {
        sessionId: session.sessionId,
        pollMs: 1,
        once: true
      });
      const outstanding = services.delivery.collectPending({
        sessionId: session.sessionId,
        surface: "monitor"
      });
      const notifications = services.delivery.collectNotifications({
        sessionId: session.sessionId,
        surface: "monitor"
      });
      const types = eventTypes(fixture);

      expect(first.outputs).toHaveLength(1);
      expect(first.outputs[0]).toContain(
        "Required monitor delivery should not reprint every poll."
      );
      expect(second.outputs).toEqual([]);
      expect(outstanding.directives).toEqual([
        expect.objectContaining({
          messageId: "msg_monitor_required",
          replyPolicy: "required",
          status: "delivered"
        })
      ]);
      expect(notifications.directives).toEqual([]);
      expect(types.filter((type) => type === "delivery.attempted")).toHaveLength(1);
      expect(types.filter((type) => type === "delivery.delivered")).toHaveLength(1);

      createServices(claudeContext(fixture)).conversations.replyToThread({
        conversationId: "conv_monitor_required",
        body: "Required reply recorded."
      });

      expect(
        services.delivery.collectPending({
          sessionId: session.sessionId,
          surface: "monitor"
        }).directives
      ).toEqual([]);
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
  const root = mkdtempSync(join(tmpdir(), "tachikoma-hooks-"));
  tempRoots.push(root);
  const store = SqliteStore.open(join(root, "tachikoma.sqlite"));
  const eventStore = new EventStore(store.db);
  const context = new ServiceContext({
    project: {
      id: "proj_hooks",
      name: "Hooks",
      repoRoot: root
    },
    eventStore,
    clock: createClock(),
    idGenerator: createIdGenerator()
  });

  return {
    store,
    eventStore,
    context
  };
}

function registerCodexReviewer(services: Services): void {
  services.agents.registerEndpoint({
    id: "agent_codex",
    name: "loki",
    runtime: "codex",
    role: "reviewer"
  });
}

function registerClaudeImpl(services: Services): void {
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
  return fixture.eventStore.listForward("proj_hooks").map((event) => event.type);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function snapshotTachikomaIdentityEnv(): Record<string, string | undefined> {
  return Object.fromEntries(TACHIKOMA_IDENTITY_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function clearTachikomaIdentityEnv(): void {
  for (const key of TACHIKOMA_IDENTITY_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreTachikomaIdentityEnv(values: Record<string, string | undefined>): void {
  for (const key of TACHIKOMA_IDENTITY_ENV_KEYS) {
    restoreEnv(key, values[key]);
  }
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
