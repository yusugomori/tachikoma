import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { codexAppServerStatePath } from "../../src/adapters/codex/app-server-state.js";
import { codexRemoteControlBindingPath } from "../../src/adapters/codex/remote-control-binding.js";
import { hostSessionBindingPath } from "../../src/adapters/hooks/session-binding.js";
import { planReset, resetStoreSiblingPaths } from "../../src/services/index.js";

describe("reset-service planReset", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plans deletion of every machine-local .tachikoma/state writer", () => {
    const root = mkdtempSync(join(tmpdir(), "tachikoma-reset-unit-"));
    roots.push(root);
    const storePath = join(root, "state", "tachikoma.sqlite");

    const plan = planReset({ cwd: root, storePath });
    const targetPaths = plan.targets.map((target) => target.path);

    // Drift guard: every adapter that writes under .tachikoma/state/ must be a reset
    // target. Adding a new state writer without listing it here (and in reset-service
    // planReset) fails this test, the way codex-remote-control.json once slipped through.
    const stateBindingPaths = [
      codexAppServerStatePath(plan.repoRoot),
      codexRemoteControlBindingPath(plan.repoRoot),
      hostSessionBindingPath(plan.repoRoot)
    ];

    for (const stateFile of stateBindingPaths) {
      expect(targetPaths).toContain(stateFile);
    }

    // The SQLite store and its WAL/SHM siblings are always planned.
    for (const sibling of resetStoreSiblingPaths(plan.storePath)) {
      expect(targetPaths).toContain(sibling);
    }
  });
});
