import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

// Lets the bot read its OWN telemetry (Workers Observability logs) so it can
// debug itself: see errors in the logs → read_source → propose_change. Like
// deploy, this goes through the tellboy-deployer control-plane Worker over the
// service binding (env.DEPLOYER.readLogs) — the Cloudflare observability token
// lives in that isolate, never in the bot, and only tellboy's logs are
// readable (the service name is hard-coded in the deployer).
//
// Enabled when the DEPLOYER binding is present; ENABLE_LOGS overrides.
export const logsPlugin: Plugin = {
  name: "logs",

  isEnabled(env) {
    return envFlag(env, "logs") ?? Boolean(env.DEPLOYER);
  },

  tools(_agent: TellboyAgent, env: Env): ToolSet {
    return {
      read_logs: tool({
        description:
          "Read the bot's own recent logs/telemetry to investigate its behaviour " +
          "or errors. Filter by level and time window. Use this to debug yourself " +
          "before proposing a fix with propose_change.",
        inputSchema: z.object({
          minutesAgo: z
            .number()
            .int()
            .min(1)
            .max(1440)
            .default(60)
            .describe("How far back to look, in minutes (max 1440 = 24h)."),
          level: z
            .enum(["all", "error", "warn", "info", "log", "debug"])
            .default("all")
            .describe("Filter by log level; 'all' for everything."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .default(50)
            .describe("Maximum number of log events to return."),
        }),
        execute: async ({ minutesAgo, level, limit }) => {
          if (!env.DEPLOYER) return { error: "Logs are not configured." };
          return env.DEPLOYER.readLogs({
            minutesAgo,
            limit,
            // The deployer treats an omitted level as "no level filter"; map
            // the "all" sentinel to that.
            level: level === "all" ? undefined : level,
          });
        },
      }),
    };
  },
};
