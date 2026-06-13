import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

// Lets the bot REQUEST a deploy of itself without holding any deploy credential.
// It calls the separate tellboy-deployer Worker (DEPLOY_URL) with an opaque
// capability secret (DEPLOY_SECRET). That Worker — a different isolate the bot
// cannot read into — holds the token that triggers the real deploy, and it
// only ever deploys tellboy. So the bot can ship a merged change, but a
// compromised bot can do nothing worse than redeploy itself.
//
// Enabled when DEPLOY_URL and DEPLOY_SECRET are both set; ENABLE_DEPLOY overrides.
export const deployPlugin: Plugin = {
  name: "deploy",

  isEnabled(env) {
    return (
      envFlag(env, "deploy") ?? Boolean(env.DEPLOY_URL && env.DEPLOY_SECRET)
    );
  },

  tools(_agent: TellboyAgent, env: Env): ToolSet {
    return {
      request_deploy: tool({
        description:
          "Deploy the current master branch of the bot to production. Use only " +
          "after a change has been merged into master. This can only ever deploy " +
          "this bot — nothing else. Returns once the deploy has been triggered.",
        inputSchema: z.object({}),
        execute: async () => {
          if (!env.DEPLOY_URL || !env.DEPLOY_SECRET) {
            return { error: "Deploy is not configured." };
          }
          const res = await fetch(`${env.DEPLOY_URL.replace(/\/$/, "")}/deploy`, {
            method: "POST",
            headers: { Authorization: `Bearer ${env.DEPLOY_SECRET}` },
          });
          if (!res.ok) {
            return { error: `Deploy trigger failed (HTTP ${res.status}).` };
          }
          return {
            ok: true,
            status: "deploy triggered — it will roll out via CI shortly",
          };
        },
      }),
    };
  },
};
