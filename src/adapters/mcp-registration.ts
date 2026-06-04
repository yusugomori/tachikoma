import { isTachikomaSourceCheckout } from "../config/source-checkout.js";

export interface McpServerCommandInput {
  repoRoot: string;
  nodeExecutable?: string;
  sourceCheckout?: boolean;
}

export interface McpRegistrationInput extends McpServerCommandInput {
  serverName?: string;
  scope?: "local" | "user" | "project";
}

export interface CommandInvocation {
  command: string;
  args: string[];
  display: string;
}

export function tachikomaBuiltCliCommand(input: McpServerCommandInput): CommandInvocation {
  const command = input.nodeExecutable ?? "node";
  const args = [`${input.repoRoot}/dist/src/cli/index.js`, "mcp"];

  return {
    command,
    args,
    display: shellCommand([command, ...args])
  };
}

export function tachikomaMcpServerCommand(input: McpServerCommandInput): CommandInvocation {
  if (input.sourceCheckout ?? isTachikomaSourceCheckout(input.repoRoot)) {
    const command = "pnpm";
    const args = ["--dir", input.repoRoot, "tachikoma", "mcp"];

    return {
      command,
      args,
      display: shellCommand([command, ...args])
    };
  }

  return tachikomaBuiltCliCommand(input);
}

export function codexMcpAddCommand(input: McpRegistrationInput): CommandInvocation {
  const server = tachikomaMcpServerCommand(input);
  const args = [
    "mcp",
    "add",
    "--env",
    `TACHIKOMA_CWD=${input.repoRoot}`,
    input.serverName ?? "tachikoma",
    "--",
    server.command,
    ...server.args
  ];

  return {
    command: "codex",
    args,
    display: shellCommand(["codex", ...args])
  };
}

export function claudeMcpAddCommand(input: McpRegistrationInput): CommandInvocation {
  const server = tachikomaMcpServerCommand(input);
  const args = [
    "mcp",
    "add",
    input.serverName ?? "tachikoma",
    "--scope",
    input.scope ?? "local",
    "-e",
    `TACHIKOMA_CWD=${input.repoRoot}`,
    "--",
    server.command,
    ...server.args
  ];

  return {
    command: "claude",
    args,
    display: shellCommand(["claude", ...args])
  };
}

export function shellCommand(parts: string[]): string {
  return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
