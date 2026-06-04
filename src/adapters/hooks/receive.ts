import type {
  DeliveryBatch,
  DeliverySurface,
  ReceiveDeliveryInput,
  ServiceContext,
  Services
} from "../../services/index.js";
import { renderHostHookOutput } from "./host.js";
import { renderBootIdentityContext, renderReceivePrompt } from "./render.js";
import type { HostHookInput, HostHookOutput } from "./types.js";

const DEFAULT_MAX_ITEMS = 5;

export interface ReceiveHookInput extends Omit<ReceiveDeliveryInput, "surface"> {
  surface?: DeliverySurface;
  host?: HostHookInput;
}

export interface ReceiveHookResult {
  output: string;
  prompt: string;
  delivery: DeliveryBatch;
  hookOutput: HostHookOutput;
}

export function runReceiveHook(
  _context: ServiceContext,
  services: Services,
  input: ReceiveHookInput
): ReceiveHookResult {
  const surface = input.surface ?? "stop";
  const delivery = services.delivery.deliverPending({
    sessionId: input.sessionId,
    agentName: input.agentName,
    surface,
    markDelivered: input.markDelivered,
    maxItems: input.maxItems ?? DEFAULT_MAX_ITEMS,
    includeClaimed: input.includeClaimed
  });
  const prompt =
    renderReceivePrompt(delivery) ||
    (isTachikomaIdentityPrompt(input.host)
      ? renderBootIdentityContext(delivery, _context.project.repoRoot ?? process.cwd())
      : "");
  const hookOutput = renderReceiveHookOutput(input.host, prompt);

  return {
    output: input.host ? renderHostHookOutput(input.host, hookOutput) : prompt,
    prompt,
    delivery,
    hookOutput
  };
}

export function isTachikomaIdentityPrompt(host: HostHookInput | undefined): boolean {
  const prompt = promptTextFromHostInput(host);

  return Boolean(prompt && /(?:^|\s)(?:\/|\$)tachikoma(?:-boot)?(?:\s|$)/.test(prompt));
}

function promptTextFromHostInput(host: HostHookInput | undefined): string | undefined {
  const record = asRecord(host?.raw);
  const candidates = [
    record?.prompt,
    record?.user_prompt,
    record?.userPrompt,
    record?.message,
    record?.input,
    record?.text
  ];

  return candidates.find((value): value is string => typeof value === "string" && value.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function renderReceiveHookOutput(host: HostHookInput | undefined, prompt: string): HostHookOutput {
  if (!prompt) {
    return { kind: "noop" };
  }

  if (host?.eventName.toLowerCase() === "stop") {
    return {
      kind: "continue",
      prompt
    };
  }

  return {
    kind: "context",
    context: prompt
  };
}
