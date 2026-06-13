# tellboy

A self-hostable, Telegram-native personal assistant running on Cloudflare
Workers. It is built on [`@cloudflare/think`](https://www.npmjs.com/package/@cloudflare/think)
and uses Think's native Telegram messenger — one Durable Object per chat for
per-conversation memory, with replies streamed back to Telegram.

The model defaults to `@cf/moonshotai/kimi-k2.6` (Workers AI) and is swappable
via the `MODEL_ID` variable.

## Prerequisites

- A Cloudflare account with Workers AI available.
- Node 22.18+ (the webhook script runs TypeScript directly).
- `pnpm`.

## Deploy your own

### 1. Create a bot with BotFather

In Telegram, message [@BotFather](https://t.me/BotFather):

- `/newbot` and follow the prompts to get a **bot token** and a **@username**.
  The token is your `TELEGRAM_BOT_TOKEN` secret (step 3); the @username (without
  the `@`) is `TELEGRAM_BOT_USERNAME` (step 2).
- Group chats: by default BotFather privacy mode hides ordinary group messages
  from the bot, so it only sees commands and @mentions. For a 1:1 assistant
  that is fine. To let the bot read all group messages, run `/setprivacy`,
  pick the bot, and choose **Disable** — then also enable the group event kinds
  in `src/agent.ts` (see the commented `respondTo` block).

### 2. Install and configure

```sh
pnpm install
```

Set the model and AI Gateway in `wrangler.jsonc` under `vars` (defaults are
fine to start), and set `TELEGRAM_BOT_USERNAME` to your bot's @username
(without the `@`):

```jsonc
"vars": {
  "MODEL_ID": "@cf/moonshotai/kimi-k2.6",
  "AI_GATEWAY_ID": "default",
  "TELEGRAM_BOT_USERNAME": "your_bot"
}
```

To change models later, edit `MODEL_ID` (any Workers AI text-generation model)
and redeploy.

### 3. Set the secrets

Pick a long random string for the webhook secret (1-256 chars, `A-Z a-z 0-9 _ -`).
The same value is used when registering the webhook.

```sh
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill it in
instead.

### 4. Deploy

```sh
pnpm deploy
```

Note the deployed URL, e.g. `https://tellboy.<your-subdomain>.workers.dev`.

### 5. Register the Telegram webhook

This points Telegram at your Worker and sets the secret token.

The script reads `WORKER_URL`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_WEBHOOK_SECRET`
from the environment. The cleanest way is to put them in `.dev.vars` (gitignored)
and source it, which keeps the token out of your shell history:

```sh
set -a; source .dev.vars; set +a
WORKER_URL="https://tellboy.<your-subdomain>.workers.dev" pnpm register-webhook
```

The script registers:

```
<WORKER_URL>/agents/tellboy-agent/tellboy/messengers/telegram/webhook
```

and prints `getWebhookInfo` so you can confirm it took. (`tellboy` is the root
agent instance name; it must match `ROOT_INSTANCE` in `src/agent.ts`. Override
with `ROOT_INSTANCE=… pnpm register-webhook` if you change it.)

Open your bot in Telegram (the `t.me/<username>` link), press **Start** or send
it a message, and confirm it replies. Private chats only deliver updates once
you have started the bot.

## Local development

```sh
pnpm dev          # wrangler dev
pnpm cf-typegen   # regenerate worker-configuration.d.ts after wrangler.jsonc edits
pnpm typecheck    # tsc --noEmit
```

Workers AI calls hit Cloudflare even in local dev and may incur usage charges.

## How it works

- `src/index.ts` — Worker entry. A `GET /` health check, then
  `routeAgentRequest` dispatches `/agents/*` to the Durable Object. An auth
  guard rejects every agent route except the secret-verified Telegram webhook
  (and blocks WebSocket upgrades), so the message history and model cannot be
  reached anonymously.
- `src/agent.ts` — `TellboyAgent extends Think`. Defines the model, system
  prompt, a writable `memory` context block, and the Telegram messenger
  (webhook path, secret verification, respond-to rules).
- `scripts/register-webhook.ts` — one-shot `setWebhook` helper.

Reasoning output is hidden from the chat (`sendReasoning = false`) and the model
runs at `reasoning_effort: "low"` for snappier replies; both are adjustable in
`src/agent.ts`.
