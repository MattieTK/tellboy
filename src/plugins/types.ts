import type { ToolSet } from "ai";
import type { TellboyAgent } from "../agent";

/**
 * A capability the bot can expose to the model as one or more tools.
 *
 * Plugins are opt-in. `getTools()` in agent.ts merges the tools of every
 * plugin whose `isEnabled()` returns true for the current environment, so
 * each plugin stays self-contained: its tools, its enablement rule, and any
 * config it reads from `env` all live in one file.
 *
 * The `import type { TellboyAgent }` is type-only, so it does not create a
 * runtime import cycle with agent.ts (which imports the plugin registry).
 */
export interface Plugin {
  /**
   * Stable identifier. Also names the override flag: a plugin called "foo" is
   * forced on or off by the `ENABLE_FOO` env var whenever that var is set.
   */
  readonly name: string;

  /**
   * Whether the plugin is active for this environment. Convention (matching
   * the "auto + env flags" policy): auto-enable from prerequisites — e.g. an
   * API key being present — but let an explicit `ENABLE_<NAME>` flag override
   * that decision. Use {@link envFlag} for the override half.
   */
  isEnabled(env: Env): boolean;

  /**
   * The AI SDK tools this plugin contributes. `agent` is the live instance,
   * used for scheduling and proactive sends; `env` is passed separately
   * because the agent's own `env` is protected and unreachable from here.
   * Called at turn start, so capturing both in the tools' `execute` closures
   * is safe.
   */
  tools(agent: TellboyAgent, env: Env): ToolSet;
}

/**
 * Read an explicit `ENABLE_<NAME>` override.
 *
 * Returns `true`/`false` when the flag is set to a recognisable value, or
 * `undefined` when it is unset — letting callers fall back to auto-detection
 * with the `??` operator: `return envFlag(env, name) ?? autoDetected`.
 */
export function envFlag(env: Env, name: string): boolean | undefined {
  const raw = (env as unknown as Record<string, unknown>)[
    `ENABLE_${name.toUpperCase()}`
  ];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
