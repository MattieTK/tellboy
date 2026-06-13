// Registers the Telegram webhook for a deployed tellboy Worker.
//
// Run with: pnpm register-webhook
// (which is `node scripts/register-webhook.ts` — Node 22.18+ strips the types).
//
// Reads from the environment (or .dev.vars-style exports), with CLI flags as
// overrides:
//   TELEGRAM_BOT_TOKEN       (required) bot token from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  (required) shared secret, echoed back in the
//                            X-Telegram-Bot-Api-Secret-Token header
//   WORKER_URL               (required) base URL of the deployed Worker,
//                            e.g. https://tellboy.<subdomain>.workers.dev
//   ROOT_INSTANCE            (optional) root agent instance name; defaults to
//                            "tellboy". MUST match ROOT_INSTANCE in src/agent.ts.
//
// CLI overrides (any of): --token=… --secret=… --url=… --instance=…
//
// The webhook URL is built to match the messenger's `path` exactly:
//   <WORKER_URL>/agents/tellboy-agent/<ROOT_INSTANCE>/messengers/telegram/webhook
// (routeAgentRequest addresses the root agent at /agents/<kebab-class>/<instance>).

// Update kinds the @chat-adapter/telegram adapter actually consumes. Limiting
// allowed_updates to these avoids waking the Worker for irrelevant updates.
const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "callback_query",
] as const;

type Args = Record<string, string>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function required(name: string, value: string | undefined): string {
  if (!value || !value.trim()) {
    console.error(`Missing ${name}. Set it via env or a CLI flag.`);
    process.exit(1);
  }
  return value.trim();
}

async function telegram<T>(token: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as { ok: boolean; description?: string; result?: T };
  if (!json.ok) {
    throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
  }
  return json.result as T;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const token = required(
    "TELEGRAM_BOT_TOKEN",
    args.token ?? process.env.TELEGRAM_BOT_TOKEN,
  );
  const secret = required(
    "TELEGRAM_WEBHOOK_SECRET",
    args.secret ?? process.env.TELEGRAM_WEBHOOK_SECRET,
  );
  const workerUrl = required("WORKER_URL", args.url ?? process.env.WORKER_URL).replace(
    /\/+$/,
    "",
  );
  // Keep in sync with ROOT_INSTANCE in src/agent.ts.
  const instance = (args.instance ?? process.env.ROOT_INSTANCE ?? "tellboy").trim();

  const webhookUrl = `${workerUrl}/agents/tellboy-agent/${instance}/messengers/telegram/webhook`;

  console.log(`Setting webhook to: ${webhookUrl}`);
  await telegram(token, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    // Existing queued updates predate this webhook; drop them so the bot does
    // not replay a backlog on first registration. Remove if you want them kept.
    drop_pending_updates: true,
  });

  const info = await telegram(token, "getWebhookInfo");
  console.log("getWebhookInfo:");
  console.log(JSON.stringify(info, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
