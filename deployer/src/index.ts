import { WorkerEntrypoint } from "cloudflare:workers";

// tellboy control-plane: a deliberately tiny, separate Worker that is the ONLY
// thing allowed to perform privileged operations on the tellboy Worker —
// deploying it, and reading its telemetry. It exists so the powerful
// credentials never sit in the same isolate as the LLM-driven bot.
//
// The bot reaches this Worker through a SERVICE BINDING (Worker-to-Worker RPC),
// not over HTTP: there is no public endpoint and no shared secret. The binding
// itself is the capability — the bot's env grants it, but the LLM can't forge
// it or read this Worker's secrets. The default fetch handler 404s and
// workers_dev is disabled, so there is no usable public surface at all.
//
// Target Worker (service), repo, workflow, ref and account are hard-coded, so
// neither RPC method takes a target the caller could redirect. Worst case if
// the bot is fully compromised: redeploy tellboy from master and read tellboy's
// own logs. Nothing else.

interface Env {
  /** GitHub token with actions:write on MattieTK/tellboy ONLY (fine-grained PAT). */
  DEPLOYER_GH_TOKEN: string;
  /** Cloudflare API token with Workers Observability read on this account. */
  CF_OBS_TOKEN: string;
}

const REPO = "MattieTK/tellboy";
const WORKFLOW = "deploy.yml";
const REF = "master";
const ACCOUNT_ID = "240e340132a0949a7f970e9c2d0e1758";
const SERVICE = "tellboy"; // the Worker whose logs may be read

const LOG_LEVELS = ["error", "warn", "info", "log", "debug"] as const;

interface LogOptions {
  minutesAgo?: number;
  limit?: number;
  level?: string;
}
interface LogEvent {
  timestamp?: number;
  level?: string;
  message?: string;
  outcome?: string;
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

export class TellboyDeployer extends WorkerEntrypoint<Env> {
  // Trigger the tellboy deploy workflow (GitHub Actions). Hard-coded repo +
  // workflow + ref — the caller cannot choose what gets deployed.
  async deploy(): Promise<{ ok: boolean; status?: string; error?: string }> {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.DEPLOYER_GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "tellboy-deployer",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref: REF }),
      },
    );
    return res.ok
      ? { ok: true, status: "deploy triggered — it will roll out via CI shortly" }
      : { ok: false, error: `deploy trigger failed: HTTP ${res.status}` };
  }

  // Read recent tellboy telemetry via Workers Observability. service is
  // hard-coded, so the caller can only ever read tellboy's own logs.
  async readLogs(
    opts: LogOptions = {},
  ): Promise<{ events: LogEvent[] } | { error: string }> {
    if (!this.env.CF_OBS_TOKEN) {
      return { error: "logs not configured (no CF_OBS_TOKEN on the deployer)" };
    }
    const to = Date.now();
    const from = to - clamp(opts.minutesAgo, 1, 1440, 60) * 60_000;
    const limit = clamp(opts.limit, 1, 200, 50);

    const filters: Array<Record<string, unknown>> = [
      { key: "$metadata.service", operation: "eq", type: "string", value: SERVICE },
    ];
    if (opts.level && LOG_LEVELS.includes(opts.level as (typeof LOG_LEVELS)[number])) {
      filters.push({
        key: "$metadata.level",
        operation: "eq",
        type: "string",
        value: opts.level,
      });
    }

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.CF_OBS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          queryId: "tellboy-selflogs",
          timeframe: { from, to },
          view: "events",
          limit,
          parameters: { datasets: [], filters, filterCombination: "and" },
        }),
      },
    );
    if (!res.ok) {
      return { error: `logs query failed: HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      result?: { events?: { events?: Array<Record<string, any>> } };
    };
    // Returned events carry their fields under `source` and `$workers`; the
    // `$metadata.*` keys are only used for filtering, not present on results.
    const events: LogEvent[] = (data.result?.events?.events ?? []).map((e) => ({
      timestamp: e.timestamp ?? e.$metadata?.timestamp,
      level: e.source?.level ?? e.$metadata?.level,
      message: e.source?.message ?? e.$metadata?.message ?? e.body,
      outcome: e.$workers?.outcome,
    }));
    return { events };
  }
}

// No usable public surface: the bot calls deploy()/readLogs() via the DEPLOYER
// service binding (RPC). Any direct HTTP gets a 404.
export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
