import type { DeliveryBatch, DeliveryService, SessionSelector } from "../../services/index.js";

export function runTurnDelivery(delivery: DeliveryService, input: SessionSelector): DeliveryBatch {
  return delivery.deliverPending({
    ...input,
    surface: "stop"
  });
}
