import { routeAgentRequest } from "agents";
import { WEBHOOK_PATH } from "./agent";

export { TellboyAgent, ThinkMessengerStateAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check. Matches the root path exactly so it cannot swallow the
    // /agents/* routes that routeAgentRequest needs (those have longer paths).
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("tellboy: ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    return (
      (await routeAgentRequest(request, env, {
        // The agent Durable Object is addressable at a predictable
        // /agents/tellboy-agent/<instance>/... path. The Think base class serves
        // framework routes there without auth of its own — notably
        // GET .../get-messages (the full transcript + memory context) and a chat
        // WebSocket that can drive the model. The Telegram webhook is the only
        // legitimate external ingress, and it self-verifies via the
        // X-Telegram-Bot-Api-Secret-Token header downstream. So we reject every
        // other HTTP route and all WebSocket upgrades here, before they reach the
        // DO. (Add an authenticated allowance here if you later want admin access
        // to e.g. the message history.)
        onBeforeRequest: (req) =>
          new URL(req.url).pathname === WEBHOOK_PATH
            ? req
            : new Response("Not found", { status: 404 }),
        onBeforeConnect: () => new Response("Not found", { status: 404 }),
      })) ?? new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
