import { describe, expect, it } from "vitest";

import { renderLaunchBanner } from "../../src/cli/launch-banner.js";

describe("launch banner", () => {
  it("renders the plain Claude banner without ANSI escapes", () => {
    expect(
      renderLaunchBanner({
        runtime: "claude",
        cwd: "/repo",
        colors: false
      })
    ).toEqual([
      "       ╷",
      "   ╭▛█████▜╮     Tachikoma Claude",
      "▗▟████ ∴ ████▙▖  Claude Code bridge · shared agent mode",
      " ╱▘╱▘▀▀▀▀▀▝╲▝╲   /repo"
    ]);
  });

  it("colors the Tachikoma body and eye separately", () => {
    const lines = renderLaunchBanner({
      runtime: "codex",
      cwd: "/repo",
      colors: true
    });

    expect(lines[1]).toContain("\u001b[38;5;39m   ╭▛█████▜╮\u001b[0m");
    expect(lines[1]).toContain("\u001b[1;37mTachikoma Codex\u001b[0m");
    expect(lines[2]).toContain(
      "\u001b[38;5;39m▗▟████\u001b[0m\u001b[38;5;16;48;5;15m ∴ \u001b[0m\u001b[38;5;39m████▙▖\u001b[0m"
    );
    expect(lines[2]).toContain("\u001b[2mCodex bridge · shared agent mode\u001b[0m");
    expect(lines[3]).toContain("\u001b[2m/repo\u001b[0m");
  });
});
