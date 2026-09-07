import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

/**
 * Scoped (categorised) long-term memory, stored on the per-thread Durable
 * Object under keys `memory:<scope>`.
 *
 * Unlike the always-injected `memory` context block (framework `withContext`,
 * edited via `set_context`), scopes are pulled into context JUST-IN-TIME: the
 * model keeps a cheap table of contents (`list_memories`) and calls
 * `recall_memory` only when a topic is relevant — the pattern Claude's memory
 * directory and ChatGPT's scoped saved memories use. This lets memory grow
 * well past what could ride in every prompt.
 */
export const MEMORY_PREFIX = "memory:";

/** One saved memory scope. */
export interface MemoryScopeEntry {
  /** Short human-readable label (also shown by list_memories). */
  label: string;
  content: string;
  updatedAt: number;
}

// Caps so a recalled scope can never blow up the context window, and the
// scope count stays enumerable. 8k chars is comfortably larger than any
// single topic needs; 40 topics is far past realistic use.
const MAX_SCOPE_CHARS = 8_000;
const MAX_SCOPES = 40;

/**
 * Normalise a scope name: lowercase, `[a-z0-9-]`, 1–32 chars. Returns the
 * clean scope or `{ error }` — tools surface the error instead of throwing.
 */
export function normalizeScope(raw: string | undefined): string | { error: string } {
  const scope = (raw ?? "general").trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9-]{1,32}$/.test(scope)) {
    return {
      error:
        "Scope must be 1–32 characters of letters, numbers and dashes (e.g. 'moving-house').",
    };
  }
  return scope;
}

/**
 * Categorised long-term memory. Dependency-free (DO storage only), so enabled
 * by default; disable with ENABLE_MEMORY=false.
 */
export const memoryPlugin: Plugin = {
  name: "memory",

  isEnabled(env) {
    return envFlag(env, "memory") ?? true;
  },

  tools(agent: TellboyAgent): ToolSet {
    return {
      set_memory: tool({
        description:
          "Write to a named memory scope — categorised long-term memory " +
          "about a topic (e.g. scope 'moving-house' for details about the " +
          "user's move). Unlike the always-injected `memory` block " +
          "(set_context), scopes are recalled on demand, so use them for " +
          "topics that only matter when they come up. Choose the most " +
          "specific scope the topic implies; reuse an existing one rather " +
          "than near-duplicates.",
        inputSchema: z.object({
          scope: z
            .string()
            .optional()
            .describe(
              "Memory scope name (1–32 chars: letters, numbers, dashes). Defaults to 'general'.",
            ),
          label: z
            .string()
            .optional()
            .describe(
              "Short human-readable label for the scope (e.g. 'Moving house'). Only needed when creating a new scope.",
            ),
          content: z.string().min(1).describe("The facts to remember."),
          action: z
            .enum(["replace", "append"])
            .optional()
            .describe(
              "Replace the scope's content (default) or append to it.",
            ),
        }),
        execute: async ({ scope, label, content, action }) => {
          const clean = normalizeScope(scope);
          if (typeof clean !== "string") return { error: clean.error };
          const trimmed = content.trim();
          if (trimmed.length > MAX_SCOPE_CHARS) {
            return { error: `Content too long (max ${MAX_SCOPE_CHARS} characters).` };
          }

          let entry: MemoryScopeEntry;
          if (action === "append") {
            const existing = await agent.getMemoryScope(clean);
            const merged = existing
              ? `${existing.content}\n${trimmed}`.slice(0, MAX_SCOPE_CHARS)
              : trimmed;
            entry = {
              label: existing?.label ?? label?.trim() ?? clean,
              content: merged,
              updatedAt: Date.now(),
            };
          } else {
            const existing = await agent.getMemoryScope(clean);
            entry = {
              label: label?.trim() ?? existing?.label ?? clean,
              content: trimmed,
              updatedAt: Date.now(),
            };
          }

          // Enforce the scope budget on create (append on an existing scope is
          // always allowed — it cannot add a new one).
          if (action !== "append") {
            const existing = await agent.listMemoryScopes();
            const isNew = !(clean in existing);
            if (isNew && Object.keys(existing).length >= MAX_SCOPES) {
              return {
                error: `Memory is full (${MAX_SCOPES} scopes). Consolidate or delete one with forget_memory first.`,
              };
            }
          }

          await agent.setMemoryScope(clean, entry);
          return { ok: true, scope: clean, label: entry.label };
        },
      }),

      list_memories: tool({
        description:
          "List saved memory scopes — names, labels, sizes and last-updated " +
          "only (no content). Call this when the user's message might relate " +
          "to something remembered about a topic; then recall_memory the " +
          "relevant scope if there is one.",
        inputSchema: z.object({}),
        execute: async () => {
          const scopes = await agent.listMemoryScopes();
          const memories = Object.entries(scopes)
            .map(([scope, e]) => ({
              scope,
              label: e.label,
              chars: e.content.length,
              updatedAt: new Date(e.updatedAt).toISOString(),
            }))
            .sort((a, b) => a.scope.localeCompare(b.scope));
          return { memories };
        },
      }),

      recall_memory: tool({
        description:
          "Load one memory scope's full content into the conversation. Use " +
          "after list_memories when a scope looks relevant to the current " +
          "topic — the content arrives as this tool's result, so it becomes " +
          "part of the context for this reply only.",
        inputSchema: z.object({
          scope: z.string().describe("The memory scope to recall."),
        }),
        execute: async ({ scope }) => {
          const clean = normalizeScope(scope);
          if (typeof clean !== "string") return { error: clean.error };
          const entry = await agent.getMemoryScope(clean);
          if (!entry) return { error: `No memory saved for scope '${clean}'.` };
          return {
            scope: clean,
            label: entry.label,
            content: entry.content,
            updatedAt: new Date(entry.updatedAt).toISOString(),
          };
        },
      }),

      forget_memory: tool({
        description:
          "Delete a memory scope entirely (e.g. when the user says a topic is " +
          "no longer relevant or asks you to forget it).",
        inputSchema: z.object({
          scope: z.string().describe("The memory scope to delete."),
        }),
        execute: async ({ scope }) => {
          const clean = normalizeScope(scope);
          if (typeof clean !== "string") return { error: clean.error };
          const existing = await agent.getMemoryScope(clean);
          if (!existing) return { error: `No memory saved for scope '${clean}'.` };
          await agent.deleteMemoryScope(clean);
          return { ok: true, scope: clean };
        },
      }),
    };
  },
};
