export const claudeInstructionsPath = "CLAUDE.md";

export function renderClaudeAgentInstructionsBlock(cliCommand = "tachikoma"): string {
  return [
    "<!-- tachikoma-agent-docs:start -->",
    "## Tachikoma",
    "",
    "This repository uses Tachikoma for shared agent knowledge.",
    "",
    "When task context is needed, read shared project memory:",
    "",
    "```bash",
    `${cliCommand} memory`,
    "```",
    "",
    "Do not read memory for simple identity, sync, or relay requests.",
    "",
    "Use Tachikoma for named-agent routing, assignments, review findings,",
    "verification results, decisions, blockers, and handoffs. Do not ingest raw",
    "transcripts by default.",
    "<!-- tachikoma-agent-docs:end -->",
    ""
  ].join("\n");
}
