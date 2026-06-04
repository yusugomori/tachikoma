import type { DeliveryBatch, DeliveryService, SessionSelector } from "../../services/index.js";

export function runMonitorDelivery(
  delivery: DeliveryService,
  input: SessionSelector
): DeliveryBatch {
  return delivery.deliverPending({
    ...input,
    surface: "monitor"
  });
}
