import type { ToolSet } from "ai";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

/**
 * One MCP server entry from the `MCP_SERVERS` JSON config.
 *
 * `url` is an HTTP(S) endpoint speaking the MCP Streamable-HTTP / SSE
 * transport. `apiKey`, when present, is sent as a `Bearer` token on every
 * request — the only auth scheme supported here. OAuth-backed servers are
 * deferred: they need an interactive callback flow this single-user bot
 * doesn't expose.
 */
export interface McpServerConfig {
  name: string;
  url: string;
  apiKey?: string;
  /**
   * Extra request headers, for servers whose auth is not a bearer token.
   *
   * The case this exists for is a server sitting behind Cloudflare Access,
   * which authenticates with `CF-Access-Client-Id` / `CF-Access-Client-Secret`
   * rather than `Authorization`. Sending those keeps Access enforcing at the
   * edge instead of the server having to open a hole for us, and the credential
   * stays revocable from the Zero Trust dashboard.
   *
   * Merged under `apiKey`, so a config that sets both still gets its bearer.
   */
  headers?: Record<string, string>;
}

/**
 * How long to wait for the MCP servers to connect before a turn proceeds. A
 * dead or slow server must not stall the chat, so this is a hard cap: Think's
 * `waitForMcpConnections` returns once every connection has connected, failed,
 * or hit this timeout (it never rejects), and the model runs with whatever
 * tools are ready.
 */
export const MCP_CONNECT_TIMEOUT_MS = 8_000;

/**
 * Parse and validate the `MCP_SERVERS` env var.
 *
 * The value is a JSON array of `{ name, url, apiKey? }`. This is pure (no I/O)
 * so it can be unit-tested and reused by both enablement and connection wiring.
 * Invalid entries are dropped rather than throwing: a malformed config should
 * degrade to "no MCP servers", never wedge boot. Returns the valid entries
 * (possibly empty) on a parseable array, or `null` when the value is absent or
 * not a JSON array at all.
 */
export function parseMcpServers(raw: string | undefined): McpServerConfig[] | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const servers: McpServerConfig[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    const url = typeof e.url === "string" ? e.url.trim() : "";
    // name and a valid http(s) url are required; anything else is dropped.
    if (name === "" || url === "") continue;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      continue;
    }
    const apiKey =
      typeof e.apiKey === "string" && e.apiKey.trim() !== ""
        ? e.apiKey.trim()
        : undefined;

    // Only string values survive: a header whose value is a number or an object
    // would stringify to something the server cannot use, and silently sending
    // "[object Object]" as a credential is worse than sending nothing.
    let headers: Record<string, string> | undefined;
    if (typeof e.headers === "object" && e.headers !== null && !Array.isArray(e.headers)) {
      const pairs = Object.entries(e.headers as Record<string, unknown>).filter(
        (pair): pair is [string, string] =>
          typeof pair[1] === "string" && pair[1].trim() !== "",
      );
      if (pairs.length > 0) headers = Object.fromEntries(pairs);
    }

    servers.push({
      name,
      url,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(headers === undefined ? {} : { headers }),
    });
  }
  return servers;
}

/**
 * Connect every configured MCP server, then return without blocking on the
 * handshakes. Called from `TellboyAgent.onStart`.
 *
 * Each server is registered via the Agents SDK base-class method
 * `agent.addMcpServer(name, url, options)`; the SDK auto-merges the servers'
 * tools into the model's toolset (Think reads them when
 * `waitForMcpConnections` is set). API-key servers send the key as a Bearer
 * token via the transport headers. We do NOT await the connection here — the
 * per-turn `waitForMcpConnections` cap is what bounds slow servers — but a
 * throw from `addMcpServer` itself (bad arg, duplicate id) is swallowed so a
 * single broken entry can't fail agent init (onStart throwing retry-loops the
 * DO).
 */
export async function connectMcpServers(
  agent: TellboyAgent,
  env: Env,
): Promise<void> {
  const servers = parseMcpServers(env.MCP_SERVERS);
  if (!servers || servers.length === 0) return;

  // Servers already connected (e.g. restored after hibernation, or a prior
  // onStart) share the same caller-supplied id, so re-adding the same name/url
  // is a no-op the SDK deduplicates rather than a duplicate connection.
  const existing = new Set(
    Object.values(agent.getMcpServers().servers).map((s) => s.server_url),
  );

  for (const server of servers) {
    if (existing.has(server.url)) continue;
    try {
      // `apiKey` last so an explicit Authorization header cannot be clobbered
      // by a config that also set one in `headers`.
      const headers: Record<string, string> = {
        ...(server.headers ?? {}),
        ...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}),
      };

      await agent.addMcpServer(server.name, server.url, {
        // Stable id from the configured name so restores/re-adds dedupe and
        // tool names stay namespaced consistently across boots.
        id: server.name,
        transport: Object.keys(headers).length > 0 ? { headers } : undefined,
      });
    } catch (err) {
      // A single bad server must not fail boot — log and keep going so the
      // other servers (and the rest of the bot) still come up.
      console.error(
        `tellboy: MCP connect failed for "${server.name}" (skipped)`,
        String(err),
      );
    }
  }
}

/**
 * Integrations gateway: connect to external MCP servers so their tools merge
 * into the model's toolset. Off by default — enabled only when `MCP_SERVERS`
 * holds a non-empty, parseable array of `{ name, url, apiKey? }`. Force on/off
 * with `ENABLE_MCP`.
 *
 * This plugin contributes no AI SDK tools of its own: the connected servers'
 * tools are auto-merged by the Agents SDK (see `connectMcpServers` and the
 * agent's `waitForMcpConnections`). `tools()` therefore returns an empty set;
 * the plugin exists so enablement is visible in `enabledPluginNames` and the
 * connection wiring has a home that matches the single-file plugin contract.
 */
export const mcpPlugin: Plugin = {
  name: "mcp",

  isEnabled(env) {
    // Explicit flag wins; otherwise auto-enable when at least one valid server
    // is configured.
    const auto = (parseMcpServers(env.MCP_SERVERS)?.length ?? 0) > 0;
    return envFlag(env, "mcp") ?? auto;
  },

  tools(): ToolSet {
    return {};
  },
};
