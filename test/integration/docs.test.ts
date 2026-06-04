import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("documentation", () => {
  it("documents Claude monitor delivery checks and fallback commands", () => {
    const docs = ["README.md", "README.ja.md"].map((path) => readFileSync(path, "utf8"));

    for (const doc of docs) {
      expect(doc).toContain("musashi");
      expect(doc).toContain('/tachikoma Send musashi: "ping"');
      expect(doc).toContain("hook receive");
      expect(doc).toContain("inbox");
    }

    const joined = docs.join("\n");
    expect(joined).toContain("Claude Monitor Delivery Check");
    expect(joined).toContain("Claude monitor delivery check");
    expect(joined).toContain("codex probe");
  });
});
