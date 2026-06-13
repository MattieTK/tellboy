import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

// Lets the bot REQUEST a deploy of itself without holding any deploy credential.
// It calls the tellboy-deployer control-plane Worker over a service binding
// (env.DEPLOYER, Worker-to-Worker RPC) — no HTTP, no secret. That Worker (a
// separate isolate the bot cannot read into) holds the token that triggers the
// real deploy, and only ever deploys tellboy. So the bot can ship a merged
// change, but a compromised bot can do nothing worse than redeploy itself.
//
// Enabled when the DEPLOYER binding is present; ENABLE_DEPLOY overrides.
export const deployPlugin: Plugin = {
  name: "deploy",

  isEnabled(env) {
    return envFlag(env, "deploy") ?? Boolean(env.DEPLOYER);
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
          if (!env.DEPLOYER) return { error: "Deploy is not configured." };
          return env.DEPLOYER.deploy();
        },
      }),
    };
  },
};
