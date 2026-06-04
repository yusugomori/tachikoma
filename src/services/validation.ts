import type { z } from "zod";

import { ValidationError } from "../domain/errors.js";

export function parseCommandInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new ValidationError(result.error.message);
  }

  return result.data;
}
