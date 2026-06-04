import type {
  DeliveryBatch,
  ServiceContext,
  Services,
  SessionSelector
} from "../../services/index.js";
import { runReceiveHook } from "./receive.js";
import { renderDeliveryBatch, renderReceivePrompt } from "./render.js";

const DEFAULT_POLL_MS = 1000;
const DEFAULT_MAX_ITEMS = 5;

export interface MonitorHookResult {
  output: string;
  delivery: DeliveryBatch;
}

export interface MonitorWatchInput extends SessionSelector {
  pollMs?: number;
  maxItems?: number;
  once?: boolean;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (output: string, delivery: DeliveryBatch) => Promise<void> | void;
}

export interface MonitorWatchResult {
  outputs: string[];
  deliveredBatches: number;
  deliveredItems: number;
  timedOut: boolean;
  aborted: boolean;
}

export function runMonitorHook(
  _context: ServiceContext,
  services: Services,
  input: SessionSelector
): MonitorHookResult {
  const result = runReceiveHook(_context, services, {
    ...input,
    surface: "monitor"
  });

  return {
    delivery: result.delivery,
    output: renderDeliveryBatch(result.delivery)
  };
}

export async function runMonitorWatch(
  _context: ServiceContext,
  services: Services,
  input: MonitorWatchInput
): Promise<MonitorWatchResult> {
  const pollMs = positiveInteger(input.pollMs, DEFAULT_POLL_MS);
  const maxItems = positiveInteger(input.maxItems, DEFAULT_MAX_ITEMS);
  const idleTimeoutMs = optionalNonNegativeInteger(input.idleTimeoutMs);
  const outputs: string[] = [];
  let deliveredBatches = 0;
  let deliveredItems = 0;
  let lastActivityAt = Date.now();

  while (!input.signal?.aborted) {
    const delivery = services.delivery.deliverNotifications({
      sessionId: input.sessionId,
      agentName: input.agentName,
      surface: "monitor",
      maxItems
    });
    const prompt = renderReceivePrompt(delivery);

    if (prompt) {
      outputs.push(prompt);
      deliveredBatches += 1;
      deliveredItems += delivery.directives.length;
      lastActivityAt = Date.now();
      await input.onOutput?.(prompt, delivery);
    }

    if (input.once) {
      return {
        outputs,
        deliveredBatches,
        deliveredItems,
        timedOut: false,
        aborted: false
      };
    }

    const idleForMs = Date.now() - lastActivityAt;
    if (idleTimeoutMs !== undefined && idleForMs >= idleTimeoutMs) {
      return {
        outputs,
        deliveredBatches,
        deliveredItems,
        timedOut: true,
        aborted: false
      };
    }

    const delayMs =
      idleTimeoutMs === undefined
        ? pollMs
        : Math.max(1, Math.min(pollMs, idleTimeoutMs - idleForMs));
    await sleep(delayMs, input.signal);
  }

  return {
    outputs,
    deliveredBatches,
    deliveredItems,
    timedOut: false,
    aborted: true
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function optionalNonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
