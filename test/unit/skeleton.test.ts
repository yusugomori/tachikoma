import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/index.js";

describe("project skeleton", () => {
  it("exports a CLI entrypoint", () => {
    expect(main).toBeTypeOf("function");
  });
});
