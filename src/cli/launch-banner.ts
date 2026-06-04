import type { CliIo } from "./io.js";

type LaunchBannerRuntime = "claude" | "codex";

interface LaunchBannerOptions {
  runtime: LaunchBannerRuntime;
  cwd: string;
  colors?: boolean;
}

const bodyColor = "38;5;39";
const eyeColor = "38;5;16;48;5;15";
const titleColor = "1;37";
const detailColor = "2";

export function writeLaunchBanner(io: CliIo, runtime: LaunchBannerRuntime, cwd: string): void {
  for (const line of renderLaunchBanner({ runtime, cwd, colors: io.colors })) {
    io.write(line);
  }
}

export function renderLaunchBanner(options: LaunchBannerOptions): string[] {
  const label = options.runtime === "claude" ? "Claude" : "Codex";
  const detail =
    options.runtime === "claude"
      ? "Claude Code bridge · shared agent mode"
      : "Codex bridge · shared agent mode";
  const color = (codes: string, value: string) =>
    options.colors ? `\u001b[${codes}m${value}\u001b[0m` : value;
  const body = (value: string) => color(bodyColor, value);
  const eye = (value: string) => color(eyeColor, value);
  const title = (value: string) => color(titleColor, value);
  const dim = (value: string) => color(detailColor, value);

  return [
    body("       ╷"),
    `${body("   ╭▛█████▜╮")}     ${title(`Tachikoma ${label}`)}`,
    `${body("▗▟████")}${eye(" ∴ ")}${body("████▙▖")}  ${dim(detail)}`,
    `${body(" ╱▘╱▘▀▀▀▀▀▝╲▝╲")}   ${dim(options.cwd)}`
  ];
}
