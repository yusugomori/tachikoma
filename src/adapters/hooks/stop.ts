import type {
  DeliveryBatch,
  ServiceContext,
  Services,
  SessionSelector
} from "../../services/index.js";
import { runReceiveHook } from "./receive.js";
import { renderDeliveryBatch } from "./render.js";

export interface StopHookResult {
  output: string;
  delivery: DeliveryBatch;
}

export function runStopHook(
  _context: ServiceContext,
  services: Services,
  input: SessionSelector
): StopHookResult {
  const result = runReceiveHook(_context, services, {
    ...input,
    surface: "stop"
  });

  return {
    delivery: result.delivery,
    output: renderDeliveryBatch(result.delivery)
  };
}
