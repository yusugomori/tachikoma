import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Command } from "commander";

import { projectStorePath } from "../config/paths.js";
import { resolveProjectRuntime } from "../config/project-config.js";
import type { EventActor } from "../domain/events.js";
import type { AgentRole, AgentRuntime } from "../domain/types.js";
import { ServiceContext, type ServiceProjectionState } from "../services/context.js";
import { createServices, type Services } from "../services/index.js";
import { EventStore } from "../store/event-store.js";
import { SqliteStore } from "../store/sqlite-store.js";
import type { CliIo } from "./io.js";

export interface CliExecutionEnvironment {
  cwd?: string;
  io: CliIo;
  stdin?: string;
}

export interface CliRuntimeOptions {
  cwd?: string;
  storePath?: string;
  projectId?: string;
  projectName?: string;
  dataRoot?: string;
  actor?: EventActor;
}

export interface CliRuntime {
  cwd: string;
  storePath: string;
  store: SqliteStore;
  eventStore: EventStore;
  context: ServiceContext;
  services: Services;
  projections(): ServiceProjectionState;
  close(): void;
}

interface RootCommandOptions {
  cwd?: string;
  store?: string;
  project?: string;
  projectName?: string;
  dataRoot?: string;
  as?: string;
  actorRuntime?: AgentRuntime;
  actorRole?: AgentRole;
  actorSession?: string;
}

export function openCliRuntime(options: CliRuntimeOptions = {}): CliRuntime {
  const resolution = resolveProjectRuntime({
    cwd: options.cwd,
    storePath: options.storePath,
    projectId: options.projectId,
    projectName: options.projectName,
    dataRoot: options.dataRoot
  });
  const { cwd, storePath } = resolution;
  mkdirSync(dirname(storePath), { recursive: true });

  const store = SqliteStore.open(storePath);
  const eventStore = new EventStore(store.db);
  const context = new ServiceContext({
    project: {
      id: resolution.projectId,
      name: resolution.projectName,
      repoRoot: cwd
    },
    eventStore,
    actor: options.actor
  });
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

export async function withCliRuntime<T>(
  command: Command,
  env: CliExecutionEnvironment,
  callback: (runtime: CliRuntime) => Promise<T> | T
): Promise<T> {
  const runtime = openCliRuntime(runtimeOptionsFromCommand(command, env));

  try {
    return await callback(runtime);
  } finally {
    runtime.close();
  }
}

export function runtimeOptionsFromCommand(
  command: Command,
  env: CliExecutionEnvironment
): CliRuntimeOptions {
  const options = command.optsWithGlobals<RootCommandOptions>();
  const cwd = resolve(options.cwd ?? env.cwd ?? process.cwd());

  return {
    cwd,
    storePath: options.store,
    projectId: options.project,
    projectName: options.projectName,
    dataRoot: options.dataRoot,
    actor: actorFromOptions(options)
  };
}

export function defaultStorePath(cwd: string, projectId?: string, dataRoot?: string): string {
  const resolution = resolveProjectRuntime({ cwd, projectId, dataRoot });

  return projectStorePath(resolution.dataRoot);
}

function actorFromOptions(options: RootCommandOptions): EventActor {
  const actor: EventActor = {};

  if (options.as) {
    actor.name = options.as;
  }

  if (options.actorRuntime) {
    actor.runtime = options.actorRuntime;
  }

  if (options.actorRole) {
    actor.role = options.actorRole;
  }

  if (options.actorSession) {
    actor.sessionId = options.actorSession;
  }

  return actor;
}
