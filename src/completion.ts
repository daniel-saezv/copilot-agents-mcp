import { z } from "zod";
import type { StateFile } from "./state.ts";

export const completionStrategySchema = z.enum(["webhook", "check_later"]);
export type CompletionStrategy = z.infer<typeof completionStrategySchema>;

export const completionSetupSchema = z.object({
  status: z.literal("required"),
  question_intent: z.string(),
  record_with: z.literal("set_completion_strategy"),
  options: z.array(z.object({
    id: completionStrategySchema,
    intent: z.string(),
    recommended: z.boolean().optional(),
  }).strict()),
  ask_instruction: z.string(),
}).strict();

export function completionSetup(state: StateFile, owner?: string, now = new Date().toISOString()) {
  const key = owner ?? "_default";
  const preference = Object.hasOwn(state.completion_prefs ?? {}, key) ? state.completion_prefs?.[key] : undefined;
  const registration = owner && Object.hasOwn(state.webhooks ?? {}, owner) ? state.webhooks?.[owner] : undefined;
  if (registration?.ownerTokenHash || preference?.strategy || preference?.asked_at) return undefined;
  state.completion_prefs ??= {};
  Object.defineProperty(state.completion_prefs, key, {
    value: { ...preference, asked_at: now },
    enumerable: true, configurable: true, writable: true,
  });
  return {
    status: "required" as const,
    question_intent: "How would you like me to follow up when your Copilot cloud tasks finish? Webhook notifications are recommended: they wake me automatically, but require one-time setup with `copilot-agents-mcp webhook register`, with your webhook URL and Authorization value entered privately, never in chat. Alternatively, check_later needs no setup: I can schedule a first check after about ten minutes and later checks no more often than every five minutes, if scheduling is supported; otherwise you can ask me for the result later. Results may arrive later with scheduled checks. I will remember your choice.",
    record_with: "set_completion_strategy" as const,
    options: [
      { id: "webhook" as const, intent: "Notify me automatically through a webhook (recommended; requires one-time local CLI setup).", recommended: true },
      { id: "check_later" as const, intent: "Check later without setup: schedule a first check in about ten minutes, then at most every five minutes, or ask for the result later." },
    ],
    ask_instruction: "Ask the user in the user’s current language without changing the meaning; record the answer with set_completion_strategy.",
  };
}

export function setCompletionStrategy(state: StateFile, owner: string | undefined, strategy: CompletionStrategy, now = new Date().toISOString()) {
  state.completion_prefs ??= {};
  const key = owner ?? "_default";
  const previous = Object.hasOwn(state.completion_prefs, key) ? state.completion_prefs[key] : undefined;
  Object.defineProperty(state.completion_prefs, key, {
    value: { ...previous, strategy, decided_at: now },
    enumerable: true, configurable: true, writable: true,
  });
  return {
    strategy,
    next_step: strategy === "webhook"
      ? "Configure a webhook locally with `copilot-agents-mcp webhook register --owner <client-name>` using hidden terminal prompts or private input files. Save the owner token in private MCP client configuration; never paste it or webhook secrets into chat. Registration applies only to eligible tasks; use check_later until registration is complete."
      : "End your turn. Schedule list_agent_tasks no sooner than check_after if supported; otherwise ask the user to request the result later. Never poll in a loop.",
  };
}
