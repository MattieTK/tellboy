import type { ToolSet } from "ai";
import type { TellboyAgent } from "../agent";
import type { Plugin } from "./types";
import { remindersPlugin } from "./reminders";
import { websearchPlugin } from "./websearch";
import { selfdevPlugin } from "./selfdev";

// Register plugins here. Order matters only on tool-name collisions (later
// wins via the spread below), so keep tool names unique across plugins.
const REGISTRY: readonly Plugin[] = [
  remindersPlugin,
  websearchPlugin,
  selfdevPlugin,
];

/**
 * Merge the tools of every plugin enabled for this environment. `env` is
 * passed in (rather than read off `agent`) because the agent's `env` is
 * protected; getTools() in agent.ts forwards `this.env`.
 */
export function collectTools(agent: TellboyAgent, env: Env): ToolSet {
  let tools: ToolSet = {};
  for (const plugin of REGISTRY) {
    if (plugin.isEnabled(env)) {
      tools = { ...tools, ...plugin.tools(agent, env) };
    }
  }
  return tools;
}

/** Names of the plugins currently enabled — handy for logging/diagnostics. */
export function enabledPluginNames(env: Env): string[] {
  return REGISTRY.filter((plugin) => plugin.isEnabled(env)).map((p) => p.name);
}
