import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

// Brave wraps matched terms in <strong> tags inside result descriptions.
// Strip any tags so the model sees clean prose, not markup.
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

interface BraveResult {
  title: string;
  url: string;
  description?: string;
}
interface BraveResponse {
  web?: { results?: BraveResult[] };
}

/**
 * Web search via the Brave Search API. Enabled automatically when
 * `BRAVE_API_KEY` is set; force on/off with `ENABLE_WEBSEARCH`.
 */
export const websearchPlugin: Plugin = {
  name: "websearch",

  isEnabled(env) {
    // Explicit flag wins; otherwise auto-enable when a key is configured.
    return envFlag(env, "websearch") ?? Boolean(env.BRAVE_API_KEY);
  },

  tools(_agent: TellboyAgent, env: Env): ToolSet {
    return {
      web_search: tool({
        description:
          "Search the public web via Brave. Use when the answer may be more " +
          "recent than your training data, or when the user wants a current " +
          "fact or a source link. Returns title, url and snippet per result.",
        inputSchema: z.object({
          query: z.string().min(2).describe("The search query."),
          count: z
            .number()
            .int()
            .min(1)
            .max(10)
            .default(5)
            .describe("Number of results to return (1-10)."),
        }),
        execute: async ({ query, count }) => {
          const key = env.BRAVE_API_KEY;
          if (!key) {
            // The tool is only registered when enabled, but the key could be
            // cleared between turns — fail soft rather than throw.
            return { error: "Web search is not configured." };
          }

          const url = new URL(BRAVE_ENDPOINT);
          url.searchParams.set("q", query);
          url.searchParams.set("count", String(count));

          const response = await fetch(url, {
            headers: {
              Accept: "application/json",
              "X-Subscription-Token": key,
            },
          });
          if (!response.ok) {
            return { error: `Brave search failed (HTTP ${response.status}).` };
          }

          const data = (await response.json()) as BraveResponse;
          const results = (data.web?.results ?? []).slice(0, count).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.description ? stripTags(r.description) : "",
          }));

          return results.length > 0
            ? { results }
            : { results: [], note: "No results found." };
        },
      }),
    };
  },
};
