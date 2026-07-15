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

## Optional capabilities and their tokens

Beyond the core chat setup, the bot ships plugins (in `src/plugins/`) that each
switch on only when their token is present. None are required for a plain chat
bot. Each token below is listed with what it unlocks, how to obtain it, and
where it lives — deliberately, the LLM-driven bot never holds a Cloudflare or
deploy credential (see the proxy note at the end).

### Web search — `BRAVE_API_KEY`

Enables the `web_search` tool (Brave Search API).

- **Get it:** create a key at <https://api-dashboard.search.brave.com/> (free tier available).
- **Lives on:** the bot Worker.
  ```sh
  echo "<key>" | pnpm exec wrangler secret put BRAVE_API_KEY
  ```

### Voice notes — on by default, no token

Inbound Telegram voice notes (and audio clips) are transcribed with a Workers
AI Whisper model on the existing `AI` binding, so there is nothing to configure.
The transcript becomes the turn's text and is echoed back to the chat so you can
spot and correct any mis-hearing. If transcription fails (e.g. the download
times out), the turn degrades to a plain "couldn't transcribe" message rather
than stalling. Set `ENABLE_VOICE` to a falsy value (`false`/`0`/`off`) to leave
voice notes untranscribed.

### Read its own source and open PRs — `GITHUB_TOKEN` (+ `GITHUB_REPO`)

The `selfdev` plugin lets the bot read its own code (`read_source`,
`list_source`) and open pull requests against its own repo (`propose_change`).
A proposed change is verified in a sandbox container (`pnpm typecheck`) before
the PR is opened, and PRs are never merged automatically — a human review is
the gate.

- **`GITHUB_REPO`** — the repo as `owner/name` (e.g. `MattieTK/tellboy`). A plain
  var in `wrangler.jsonc`, not a secret.
- **`GITHUB_TOKEN`** — a GitHub **fine-grained PAT** scoped to *only this repo*,
  with **Contents: Read and write** and **Pull requests: Read and write**, and
  nothing else.
  - **Get it:** <https://github.com/settings/personal-access-tokens/new> →
    Resource owner = your account → Repository access = *Only select
    repositories* → pick this repo → Permissions: Contents = Read and write,
    Pull requests = Read and write. Leave **Actions/Workflows at No access** —
    granting them would let the bot trigger deploys directly and bypass the
    deploy proxy below.
  - **Lives on:** the bot Worker.
    ```sh
    echo "<pat>" | pnpm exec wrangler secret put GITHUB_TOKEN
    ```

### Deploy itself and read its own logs — the control-plane proxy

So the bot never holds a deploy or account-wide credential, the privileged
operations live in a *separate* Worker, `tellboy-deployer` (`deployer/`). The
bot reaches it over a service binding (`env.DEPLOYER`, Worker-to-Worker RPC) —
no public URL, no shared secret. The proxy exposes exactly two operations, both
hard-coded to this project: `deploy()` (triggers the deploy workflow) and
`readLogs()` (reads this Worker's own telemetry). Its credentials stay in its
own isolate, unreadable by the bot.

Deploy the proxy once, then give it its two secrets:

```sh
pnpm exec wrangler deploy --config deployer/wrangler.jsonc
```

- **`DEPLOYER_GH_TOKEN`** — a fine-grained PAT scoped to *only this repo* with
  **Actions: Read and write** (used to dispatch the deploy workflow).
  - **Get it:** same PAT page as above; this repo only; Permissions: Actions =
    Read and write.
  - **Lives on:** the deployer Worker.
    ```sh
    echo "<pat>" | pnpm exec wrangler secret put DEPLOYER_GH_TOKEN --config deployer/wrangler.jsonc
    ```
- **`CF_OBS_TOKEN`** — a Cloudflare API token that can read Workers Observability
  logs, so `read_logs` returns data.
  - **Get it:** Cloudflare dashboard → **My Profile** → **API Tokens** → **Create
    Custom Token** → Permissions: **Account › Workers Observability › Read** (or
    **Account › Account Analytics › Read** if that exact name isn't offered) →
    Account resources = your account.
  - **Lives on:** the deployer Worker.
    ```sh
    echo "<token>" | pnpm exec wrangler secret put CF_OBS_TOKEN --config deployer/wrangler.jsonc
    ```

The real deploy runs in GitHub Actions (`.github/workflows/deploy.yml`) on merge
to `master` (or when the proxy triggers it), so CI — not the bot — holds the
deploy credential:

- **`CLOUDFLARE_API_TOKEN`** — deploys the Worker and its container.
  - **Get it:** Cloudflare dashboard → **My Profile** → **API Tokens** → **Create
    Token** → **Edit Cloudflare Workers** template → your account. If the
    container step later fails on permissions, edit the token and add
    **Account › Cloudchamber › Edit**.
  - **Lives on:** GitHub Actions repo secret.
    ```sh
    gh secret set CLOUDFLARE_API_TOKEN -R <owner>/<repo>
    ```
- **`CLOUDFLARE_ACCOUNT_ID`** — your account ID (from `wrangler whoami` or the
  dashboard URL).
    ```sh
    gh secret set CLOUDFLARE_ACCOUNT_ID -R <owner>/<repo>
    ```

#### Where each secret lives

| Secret | Lives on | Unlocks |
| --- | --- | --- |
| `BRAVE_API_KEY` | bot Worker | web search |
| `GITHUB_TOKEN` (+ `GITHUB_REPO` var) | bot Worker | read source, open PRs |
| `DEPLOYER_GH_TOKEN` | deployer Worker | trigger the deploy workflow |
| `CF_OBS_TOKEN` | deployer Worker | read its own logs |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions | run the deploy |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions | run the deploy |

The bot Worker holds no Cloudflare or deploy credential — only the `DEPLOYER`
service binding, which can do nothing but deploy this bot and read this bot's
logs. For local development, the bot-Worker secrets can instead go in
`.dev.vars` (gitignored).

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

## License

This project is licensed under the MIT License. See the `LICENSE` file for
details.
