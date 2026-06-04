import { z } from "zod";

import { RoutingTargetAmbiguousError, RoutingTargetNotFoundError } from "../domain/errors.js";
import { routingTargetSchema } from "../domain/schemas.js";
import type { RoutingTarget } from "../domain/types.js";
import { type RoutingResolution, resolveRoutingTarget } from "../projections/index.js";
import type { ServiceContext } from "./context.js";
import { parseCommandInput } from "./validation.js";

const routingTargetInputSchema = z.union([z.string().min(1), routingTargetSchema]);

export type RoutingTargetInput = z.input<typeof routingTargetInputSchema>;

export class RoutingService {
  public constructor(private readonly context: ServiceContext) {}

  public normalizeTarget(input: RoutingTargetInput): RoutingTarget {
    const parsed = parseCommandInput(routingTargetInputSchema, input);

    if (typeof parsed === "string") {
      return {
        kind: "agent",
        name: parsed
      };
    }

    return parsed;
  }

  public resolve(input: RoutingTargetInput): RoutingResolution {
    const target = this.normalizeTarget(input);
    const resolution = resolveRoutingTarget(this.context.projections().agents, target);

    if (resolution.status === "unknown") {
      throw new RoutingTargetNotFoundError(formatRoutingTarget(target));
    }

    if (resolution.status === "ambiguous") {
      throw new RoutingTargetAmbiguousError(
        formatRoutingTarget(target),
        resolution.candidates.map((candidate) => candidate.name)
      );
    }

    return resolution;
  }

  public assertRoutable(input: RoutingTargetInput): RoutingTarget {
    this.resolve(input);
    return this.normalizeTarget(input);
  }
}

export function formatRoutingTarget(target: RoutingTarget): string {
  switch (target.kind) {
    case "agent":
      return target.name;
    case "role":
      return `role:${target.role}`;
    case "runtime-role":
      return `runtime-role:${target.runtime}:${target.role}`;
    case "session":
      return `session:${target.sessionId}`;
    case "broadcast":
      return `broadcast:${target.runtime ?? "*"}:${target.role ?? "*"}`;
  }
}
