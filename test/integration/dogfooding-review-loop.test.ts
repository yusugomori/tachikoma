import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/index.js";
import type { CliIo } from "../../src/cli/io.js";

describe("dogfooding named-agent review loop", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes work through joined agents and exports regenerated reports", async () => {
    const cli = createCliHarness(roots);

    await cli.run("init");
    await cli.run("join", "loki", "--runtime", "codex", "--role", "reviewer");
    await cli.run("agent", "register", "musashi", "--runtime", "claude", "--role", "implementer");

    const ask = await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "ask",
      "musashi",
      "implement the dogfood review loop"
    );
    const threadId = extract("conversation", ask);

    expect(await cli.run("inbox", "--as", "musashi")).toContain("[queued]");

    const claudeJoin = await cli.run(
      "join",
      "musashi",
      "--runtime",
      "claude",
      "--role",
      "implementer"
    );

    expect(claudeJoin).toContain("claimed: 1");

    await cli.run(
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "implementer",
      "reply",
      threadId,
      "implementation is ready for review"
    );

    const claim = await cli.run(
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "implementer",
      "claim",
      "record",
      "--thread",
      threadId,
      "--summary",
      "dogfood implementation complete",
      "--file",
      "src/example.ts",
      "--expect",
      "pnpm test",
      "--request-review",
      "--reviewer",
      "loki"
    );
    const claimId = extract("claim", claim);
    const requestId = extract("review_request", claim);

    expect(await cli.run("inbox", "--as", "loki")).toContain("Review implementation");

    const finding = await cli.run(
      "--as",
      "loki",
      "--actor-runtime",
      "codex",
      "--actor-role",
      "reviewer",
      "review",
      "finding",
      "--thread",
      threadId,
      "--request",
      requestId,
      "--claim",
      claimId,
      "--summary",
      "Missing cleanup path",
      "--to",
      "musashi"
    );
    const findingId = extract("review_finding", finding);

    expect(await cli.run("inbox", "--as", "musashi")).toContain("Missing cleanup path");

    await cli.run(
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "implementer",
      "review",
      "address",
      "--thread",
      threadId,
      "--request",
      requestId,
      "--claim",
      claimId,
      "--finding",
      findingId,
      "--summary",
      "cleanup path added",
      "--reviewer",
      "loki"
    );

    expect(await cli.run("inbox", "--as", "loki")).toContain("cleanup path added");

    await cli.run(
      "--as",
      "musashi",
      "--actor-runtime",
      "claude",
      "--actor-role",
      "implementer",
      "verification",
      "record",
      "--thread",
      threadId,
      "--claim",
      claimId,
      "--status",
      "passed",
      "--summary",
      "pnpm test passed",
      "--command",
      "pnpm test"
    );

    const markdownReportPath = join(cli.root, ".tachikoma", "reports", "dogfood.md");
    const jsonReportPath = join(cli.root, ".tachikoma", "reports", "dogfood.json");
    const handoffPath = join(cli.root, ".tachikoma", "reports", "handoff.md");

    await cli.run("report", "export", ".tachikoma/reports/dogfood.md", "--format", "markdown");
    await cli.run("report", "export", ".tachikoma/reports/dogfood.json", "--format", "json");
    await cli.run(
      "report",
      "handoff",
      ".tachikoma/reports/handoff.md",
      "--summary",
      "ready for reviewer pickup"
    );

    expect(existsSync(markdownReportPath)).toBe(true);
    expect(readFileSync(markdownReportPath, "utf8")).toContain("dogfood implementation complete");
    expect(readFileSync(markdownReportPath, "utf8")).toContain("Last event:");
    expect(readFileSync(handoffPath, "utf8")).toContain("ready for reviewer pickup");

    const jsonReport = JSON.parse(readFileSync(jsonReportPath, "utf8")) as {
      project?: { name?: string };
      eventLog?: { count?: number; recentEventIds?: string[] };
    };

    expect(jsonReport.project?.name).toBe("Dogfood Test");
    expect(jsonReport.eventLog?.count).toBeGreaterThan(0);
    expect(jsonReport.eventLog?.recentEventIds?.length).toBeGreaterThan(0);
    expect(await cli.run("status")).toContain("Project: Dogfood Test");
  });
});

interface CliHarness {
  root: string;
  storePath: string;
  run(...argv: string[]): Promise<string>;
}

function createCliHarness(roots: string[]): CliHarness {
  const root = mkdtempSync(join(tmpdir(), "tachikoma-dogfood-"));
  roots.push(root);
  const storePath = join(root, "state", "tachikoma.sqlite");
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIo = {
    write: (message) => {
      if (message.length > 0) {
        output.push(message);
      }
    },
    error: (message) => {
      if (message.length > 0) {
        errors.push(message);
      }
    }
  };

  return {
    root,
    storePath,
    run: async (...argv: string[]) => {
      const outputStart = output.length;
      const errorStart = errors.length;

      await main(
        [
          "--store",
          storePath,
          "--project",
          "dogfood-test",
          "--project-name",
          "Dogfood Test",
          ...argv
        ],
        {
          cwd: root,
          io
        }
      );

      const newErrors = errors.slice(errorStart);
      if (newErrors.length > 0) {
        throw new Error(newErrors.join("\n"));
      }

      return output.slice(outputStart).join("\n");
    }
  };
}

function extract(label: string, output: string): string {
  const pattern = new RegExp(`^${label}:\\s*(.+)$`, "m");
  const match = pattern.exec(output);

  if (!match?.[1]) {
    throw new Error(`Missing ${label} in output:\n${output}`);
  }

  return match[1].trim();
}
