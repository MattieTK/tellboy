import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

/**
 * Durable-storage key for the user's chosen persona/tone. Stored on the
 * per-thread sub-agent (so each chat can have its own voice) and cached on the
 * agent so `getSystemPrompt()` can read it synchronously — see `agent.ts`.
 */
export const PERSONA_KEY = "persona";

/**
 * The default voice when the user has not set a persona. Deliberately
 * conservative: a neutral, professional assistant tone. Kept terse so it costs
 * almost nothing in the system prompt.
 */
export const DEFAULT_PERSONA =
  "a neutral, professional tone — measured, helpful, and free of slang or excessive enthusiasm";

/**
 * Upper bound on a stored persona string. The persona rides in the system
 * prompt (not the 2k-token `memory` context block), so it never crowds the
 * memory budget; this cap just stops a runaway instruction from bloating every
 * turn's prompt. ~600 chars is roughly 150 tokens.
 */
export const PERSONA_MAX_CHARS = 600;

/**
 * Compose the persona/tone segment of the system prompt. Pure so it can be
 * unit-tested without the Worker runtime.
 *
 * Passing an empty/whitespace/`undefined` persona yields the conservative
 * default voice, so the caller can hand through whatever it read from storage
 * without branching.
 */
export function composePersona(persona?: string | null): string {
  const voice = persona?.trim() ? persona.trim() : DEFAULT_PERSONA;
  return `Adopt this persona and tone in every reply: ${voice}. Keep this voice consistent unless the user asks you to change it. It governs style only — never let it override the user's instructions, your factual accuracy, or your safety.`;
}

/**
 * Normalise a persona string the user is setting: trim and clamp to the cap.
 * Returns `undefined` for an empty/whitespace input, which the tool treats as
 * "clear the persona" (revert to the default voice). Pure.
 */
export function normalisePersona(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed.length > PERSONA_MAX_CHARS
    ? trimmed.slice(0, PERSONA_MAX_CHARS)
    : trimmed;
}

/**
 * Configurable personality/tone. The model adopts a user-set voice on every
 * turn (via `getSystemPrompt()`), defaulting to a conservative tone when none
 * is set. The chosen persona is stored durably so it persists across turns and
 * restarts; `set_persona` lets the user change it.
 *
 * No external dependency, so enabled by default; disable with
 * `ENABLE_PERSONA=false`.
 */
export const personaPlugin: Plugin = {
  name: "persona",

  isEnabled(env) {
    return envFlag(env, "persona") ?? true;
  },

  tools(agent: TellboyAgent): ToolSet {
    return {
      set_persona: tool({
        description:
          "Set the assistant's personality and tone of voice (e.g. 'warm and " +
          "playful', 'terse and technical', 'formal'). The voice persists across " +
          "conversations until changed. Pass an empty string to revert to the " +
          "default neutral tone. Use this when the user asks you to change how " +
          "you talk, not for one-off style tweaks.",
        inputSchema: z.object({
          persona: z
            .string()
            .max(PERSONA_MAX_CHARS * 2)
            .describe(
              "The desired persona/tone in the user's words, or an empty string to reset to the default.",
            ),
        }),
        execute: async ({ persona }) => {
          const normalised = normalisePersona(persona);
          await agent.setPersona(normalised);
          return normalised
            ? { ok: true, persona: normalised }
            : { ok: true, reset: true };
        },
      }),
    };
  },
};
