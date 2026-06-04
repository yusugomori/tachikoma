import type { Command } from "commander";

import type { AgentsProjectionState } from "../../projections/index.js";
import {
  type DiagnosticItem,
  type DiagnosticStatus,
  diagnoseInstall
} from "../../services/index.js";
import { type CliColor, colorize } from "../io.js";
import {
  type CliExecutionEnvironment,
  openCliRuntime,
  runtimeOptionsFromCommand
} from "../runtime.js";

export function registerDoctorCommand(program: Command, env: CliExecutionEnvironment): void {
  program
    .command("doctor")
    .description("Diagnose local Tachikoma state.")
    .action(async function (this: Command) {
      const runtimeOptions = runtimeOptionsFromCommand(this, env);
      const diagnostics = diagnoseInstall({
        repoRoot: runtimeOptions.cwd,
        dataRoot: runtimeOptions.dataRoot,
        storePath: runtimeOptions.storePath,
        projectId: runtimeOptions.projectId,
        projectName: runtimeOptions.projectName
      });

      env.io.write(`cwd: ${diagnostics.repoRoot}`);
      writeDiagnostic(env, "project config", diagnostics.projectConfig);
      env.io.write(`project: ${diagnostics.projectId} (${diagnostics.projectName})`);
      env.io.write(`data root: ${diagnostics.dataRoot}`);
      writeDiagnostic(env, "store", diagnostics.store);
      writeDiagnostic(env, "codex hooks", diagnostics.codexHostHooks);
      writeDiagnostic(env, "claude hooks", diagnostics.claudeHostHooks);
      writeDiagnostic(env, "codex trust", diagnostics.codexTrust, "message");
      writeDiagnostic(env, "codex skill", diagnostics.codexSkill, "message");
      writeDiagnostic(env, "claude skill", diagnostics.claudeSkill, "message");
      writeDiagnostic(env, "claude monitor", diagnostics.claudeMonitor, "message");
      writeDiagnostic(env, "mcp config", diagnostics.mcpConfig);
      writeClaudeMonitorTroubleshooting(env);

      if (diagnostics.store.status !== "ok") {
        env.io.write("events: unknown (store missing)");
        env.io.write("project initialized: unknown (store missing)");
        env.io.write("agents: unknown (store missing)");
        env.io.write("pending inbox: unknown (store missing)");
        return;
      }

      const runtime = openCliRuntime(runtimeOptions);

      try {
        const projections = runtime.projections();

        env.io.write(`events: ${runtime.context.events().length}`);
        env.io.write(`project initialized: ${projections.projectState.project ? "yes" : "no"}`);
        env.io.write(`agents: ${projections.agents.endpoints.length}`);
        env.io.write(`pending inbox: ${projections.brief.pendingInboxCount}`);
        writeClaudeMonitorSessionSummary(env, projections.agents);
      } finally {
        runtime.close();
      }
    });
}

function writeDiagnostic(
  env: CliExecutionEnvironment,
  label: string,
  item: DiagnosticItem,
  detail: "path" | "message" = "path"
): void {
  const status = colorize(env.io, colorForDiagnosticStatus(item.status), item.status);
  const suffix = detail === "message" ? item.message : item.path;

  env.io.write(`${label}: ${status} ${suffix}`);
}

function colorForDiagnosticStatus(status: DiagnosticStatus): CliColor {
  switch (status) {
    case "ok":
      return "green";
    case "missing":
      return "yellow";
    case "error":
      return "red";
  }
}

function writeClaudeMonitorTroubleshooting(env: CliExecutionEnvironment): void {
  for (const line of [
    "claude monitor troubleshooting:",
    "- monitor exits immediately: do not use --idle-timeout-ms for normal watch mode.",
    "- no active session: run /tachikoma-boot <name> <role> or tachikoma join with --delivery-mode monitor.",
    "- hooks silent: restart Claude Code and approve/review .claude/settings.local.json hooks.",
    "- name already live: choose another name or intentionally rejoin with --takeover.",
    "- delivery mode turn/off: use monitor or both, or fall back to hook receive and inbox polling."
  ]) {
    env.io.write(line);
  }
}

function writeClaudeMonitorSessionSummary(
  env: CliExecutionEnvironment,
  agents: AgentsProjectionState
): void {
  const endpointById = new Map(agents.endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const liveClaudeSessions = agents.sessions.filter(
    (session) => session.runtime === "claude" && !session.endedAt
  );
  const monitorSessions = liveClaudeSessions.filter(
    (session) => session.deliveryMode === "monitor" || session.deliveryMode === "both"
  );
  const fallbackSessions = liveClaudeSessions.filter(
    (session) => session.deliveryMode === "turn" || session.deliveryMode === "off"
  );

  env.io.write(`claude monitor live sessions: ${monitorSessions.length}`);

  if (fallbackSessions.length > 0) {
    env.io.write(
      `claude monitor fallback sessions: ${fallbackSessions
        .map((session) => {
          const endpoint = endpointById.get(session.agentId);

          return `${endpoint?.name ?? session.agentId}:${session.deliveryMode}`;
        })
        .join(", ")}`
    );
  }
}
