import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { projectStorePath } from "../config/paths.js";
import { resolveProjectRuntime } from "../config/project-config.js";
import type { EventActor } from "../domain/events.js";
import type { AgentRole, AgentRuntime } from "../domain/types.js";
import { liveSessionsForEndpoint } from "../projections/index.js";
import { ServiceContext, type ServiceProjectionState } from "../services/context.js";
import { createServices, type Services } from "../services/index.js";
import { EventStore } from "../store/event-store.js";
import { SqliteStore } from "../store/sqlite-store.js";

export interface McpRuntimeDefaults {
  cwd?: string;
  storePath?: string;
  projectId?: string;
  projectName?: string;
  dataRoot?: string;
  actor?: EventActor;
}

export interface McpContextInput {
  cwd?: string;
  store?: string;
  projectId?: string;
  projectName?: string;
  dataRoot?: string;
  actorName?: string;
  actorRuntime?: AgentRuntime;
  actorRole?: AgentRole;
  actorSession?: string;
}

export interface McpRuntime {
  cwd: string;
  storePath: string;
  store: SqliteStore;
  eventStore: EventStore;
  context: ServiceContext;
  services: Services;
  projections(): ServiceProjectionState;
  close(): void;
}

export function openMcpRuntime(
  defaults: McpRuntimeDefaults = {},
  input: McpContextInput = {}
): McpRuntime {
  const resolution = resolveProjectRuntime({
    cwd: input.cwd ?? defaults.cwd ?? process.env.TACHIKOMA_CWD ?? process.cwd(),
    storePath: input.store ?? defaults.storePath,
    projectId: input.projectId ?? defaults.projectId ?? process.env.TACHIKOMA_PROJECT,
    projectName: input.projectName ?? defaults.projectName ?? process.env.TACHIKOMA_PROJECT_NAME,
    dataRoot: input.dataRoot ?? defaults.dataRoot ?? process.env.TACHIKOMA_HOME
  });
  const { cwd, storePath } = resolution;
  mkdirSync(dirname(storePath), { recursive: true });

  const store = SqliteStore.open(storePath);
  const eventStore = new EventStore(store.db);
  const baseContext = new ServiceContext({
    project: {
      id: resolution.projectId,
      name: resolution.projectName,
      repoRoot: cwd
    },
    eventStore,
    actor: {
      ...(defaults.actor ?? {}),
      ...actorFromInput(input)
    }
  });
  const context = baseContext.withActor(resolveActorFromLiveSession(baseContext));
  const services = createServices(context);

  return {
    cwd,
    storePath,
    store,
    eventStore,
    context,
    services,
    projections: () => context.projections(),
    close: () => {
      store.close();
    }
  };
}

export async function withMcpRuntime<T>(
  defaults: McpRuntimeDefaults,
  input: McpContextInput,
  callback: (runtime: McpRuntime) => Promise<T> | T
): Promise<T> {
  const runtime = openMcpRuntime(defaults, input);

  try {
    return await callback(runtime);
  } finally {
    runtime.close();
  }
}

export function mcpDefaultsFromArgv(argv = process.argv.slice(2)): McpRuntimeDefaults {
  return {
    cwd: valueAfter(argv, "--cwd") ?? process.env.TACHIKOMA_CWD,
    storePath: valueAfter(argv, "--store") ?? process.env.TACHIKOMA_STORE,
    projectId: valueAfter(argv, "--project") ?? process.env.TACHIKOMA_PROJECT,
    projectName: valueAfter(argv, "--project-name") ?? process.env.TACHIKOMA_PROJECT_NAME,
    dataRoot: valueAfter(argv, "--data-root") ?? process.env.TACHIKOMA_HOME,
    actor: {
      name:
        valueAfter(argv, "--as") ??
        process.env.TACHIKOMA_ACTOR_NAME ??
        process.env.TACHIKOMA_AGENT_NAME,
      runtime: (valueAfter(argv, "--actor-runtime") ??
        process.env.TACHIKOMA_ACTOR_RUNTIME ??
        process.env.TACHIKOMA_RUNTIME) as AgentRuntime | undefined,
      role: (valueAfter(argv, "--actor-role") ??
        process.env.TACHIKOMA_ACTOR_ROLE ??
        process.env.TACHIKOMA_ROLE) as AgentRole | undefined,
      sessionId:
        valueAfter(argv, "--actor-session") ??
        process.env.TACHIKOMA_ACTOR_SESSION ??
        process.env.TACHIKOMA_SESSION_ID
    }
  };
}

export function defaultMcpStorePath(cwd: string, projectId?: string, dataRoot?: string): string {
  const resolution = resolveProjectRuntime({ cwd, projectId, dataRoot });

  return projectStorePath(resolution.dataRoot);
}

function resolveActorFromLiveSession(context: ServiceContext): EventActor {
  const actor = context.actor;

  if (actor.name || actor.agentId) {
    return actor;
  }

  const sessionActor = actor.sessionId ? resolveActorFromExactLiveSession(context) : undefined;

  if (sessionActor) {
    return sessionActor;
  }

  if (actor.sessionId) {
    return actor;
  }

  const projections = context.projections();
  const liveEndpoints = projections.agents.endpoints
    .map((endpoint) => ({
      endpoint,
      liveSessions: liveSessionsForEndpoint(projections.agents, endpoint)
    }))
    .filter(
      ({ endpoint, liveSessions }) =>
        liveSessions.length > 0 && (!actor.runtime || endpoint.runtime === actor.runtime)
    );

  if (liveEndpoints.length !== 1) {
    return actor;
  }

  const match = liveEndpoints[0];

  if (!match) {
    return actor;
  }

  const { endpoint, liveSessions } = match;
  const latestSession = liveSessions.at(-1);

  return {
    ...actor,
    name: endpoint.name,
    runtime: endpoint.runtime,
    role: actor.role ?? endpoint.role ?? latestSession?.role,
    sessionId: latestSession?.id
  };
}

function resolveActorFromExactLiveSession(context: ServiceContext): EventActor | undefined {
  const actor = context.actor;

  if (!actor.sessionId) {
    return undefined;
  }

  const projections = context.projections();
  const matches = projections.agents.endpoints
    .filter((endpoint) => !actor.runtime || endpoint.runtime === actor.runtime)
    .flatMap((endpoint) =>
      liveSessionsForEndpoint(projections.agents, endpoint)
        .filter((session) => session.id === actor.sessionId)
        .map((session) => ({
          endpoint,
          session
        }))
    );

  if (matches.length !== 1) {
    return undefined;
  }

  const match = matches[0];

  if (!match) {
    return undefined;
  }

  return {
    ...actor,
    agentId: match.endpoint.id,
    name: match.endpoint.name,
    runtime: match.endpoint.runtime,
    role: actor.role ?? match.endpoint.role ?? match.session.role,
    sessionId: match.session.id
  };
}

function actorFromInput(input: McpContextInput): EventActor {
  const actor: EventActor = {};

  if (input.actorName) {
    actor.name = input.actorName;
  }

  if (input.actorRuntime) {
    actor.runtime = input.actorRuntime;
  }

  if (input.actorRole) {
    actor.role = input.actorRole;
  }

  if (input.actorSession) {
    actor.sessionId = input.actorSession;
  }

  return actor;
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);

  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}
