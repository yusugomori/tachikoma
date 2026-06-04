import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isTachikomaSourceCheckout,
  tachikomaCliInvocation
} from "../../src/config/source-checkout.js";

describe("source checkout detection", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "tachikoma-checkout-"));
    roots.push(root);
    return root;
  }

  function writeSourceCheckout(root: string, name = "@yusugomori/tachikoma"): void {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name, scripts: { tachikoma: "tsx src/cli/index.ts" } })
    );
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    writeFileSync(join(root, "src", "cli", "index.ts"), "");
  }

  it("recognizes a tachikoma source checkout", () => {
    const root = makeRoot();
    writeSourceCheckout(root);

    expect(isTachikomaSourceCheckout(root)).toBe(true);
  });

  it("accepts the unscoped package name", () => {
    const root = makeRoot();
    writeSourceCheckout(root, "tachikoma");

    expect(isTachikomaSourceCheckout(root)).toBe(true);
  });

  it("rejects a directory with no manifest", () => {
    expect(isTachikomaSourceCheckout(makeRoot())).toBe(false);
  });

  it("rejects an unrelated package even with the CLI entrypoint present", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "some-consumer", scripts: { tachikoma: "tachikoma" } })
    );
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    writeFileSync(join(root, "src", "cli", "index.ts"), "");

    expect(isTachikomaSourceCheckout(root)).toBe(false);
  });

  it("rejects the tachikoma package without the source entrypoint (a global install)", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@yusugomori/tachikoma", scripts: { tachikoma: "tachikoma" } })
    );

    expect(isTachikomaSourceCheckout(root)).toBe(false);
  });

  it("drives the CLI through pnpm inside a source checkout", () => {
    const root = makeRoot();
    writeSourceCheckout(root);

    expect(tachikomaCliInvocation(root)).toEqual({
      command: "pnpm",
      leadingArgs: ["--dir", root, "tachikoma"]
    });
  });

  it("uses the global binary outside a source checkout", () => {
    expect(tachikomaCliInvocation(makeRoot())).toEqual({
      command: "tachikoma",
      leadingArgs: []
    });
  });
});
