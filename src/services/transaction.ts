import type { EventEnvelope } from "../domain/events.js";
import type { ServiceContext, ServiceEventInput } from "./context.js";

export function appendCommandEvents(
  context: ServiceContext,
  events: ServiceEventInput[]
): EventEnvelope[] {
  return context.appendEvents(events);
}
