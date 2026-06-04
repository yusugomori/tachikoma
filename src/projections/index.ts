import { agentsProjection } from "./agents.js";
import { claimsProjection } from "./claims.js";
import { conversationsProjection } from "./conversations.js";
import { inboxProjection } from "./inbox.js";
import { projectStateProjection } from "./project-state.js";
import { reviewsProjection } from "./reviews.js";
import { tasksProjection } from "./tasks.js";
import type { Projection } from "./types.js";
import { verificationProjection } from "./verification.js";

export * from "./agents.js";
export * from "./brief.js";
export * from "./claims.js";
export * from "./conversations.js";
export * from "./engine.js";
export * from "./inbox.js";
export * from "./project-state.js";
export * from "./rebuild.js";
export * from "./reviews.js";
export * from "./tasks.js";
export * from "./types.js";
export * from "./verification.js";

export const coreProjections: Projection<unknown>[] = [
  projectStateProjection as Projection<unknown>,
  agentsProjection as Projection<unknown>,
  inboxProjection as Projection<unknown>,
  tasksProjection as Projection<unknown>,
  claimsProjection as Projection<unknown>,
  reviewsProjection as Projection<unknown>,
  verificationProjection as Projection<unknown>,
  conversationsProjection as Projection<unknown>
];
