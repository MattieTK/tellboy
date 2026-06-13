# AGENTS.md

Notes for agents (and humans) working on tellboy. See `README.md` for setup and
`src/agent.ts` for the main wiring.

## Self-modification is gated by tests, not humans

The bot can read its own source, open PRs, **and merge its own `bot/*` PRs**, so
self-improvement runs end-to-end with no human in the loop. The gates are
automated and must stay meaningful:

- `propose_change` only opens a PR if `pnpm typecheck` **and** `pnpm test` pass
  in the sandbox (`TellboyAgent.runVerifiedChange`).
- CI (`.github/workflows/deploy.yml`) re-runs `pnpm typecheck` + `pnpm test`
  before a merged change deploys.
- `merge_pull_request`/`close_pull_request` are scoped to `bot/*` branches;
  `propose_change` refuses `.github/` and `deployer/`.

**Therefore: keep `tests/` covering the core, and never weaken the CI/sandbox
gate.** Tests run in plain Node (`vitest`), so they can only cover modules that
don't import `cloudflare:workers` (formatting, plugin enablement, the GitHub
client) — `agent.ts`/`index.ts` are covered by `pnpm typecheck`. If you add
runtime/worker behaviour worth protecting, add `@cloudflare/vitest-pool-workers`
integration tests rather than letting the gate go stale.

## Gotchas

### Scheduled alarms run on the top-level agent, not the per-thread sub-agent

Each Telegram chat runs in its own per-thread **sub-agent** (a facet), but
`this.schedule(...)` alarms are owned by the **top-level** agent that owns the
Durable Object's alarm. So a scheduled callback (e.g. `deliverReminder`,
`runVerifiedChange`) does **not** reliably see state written by the sub-agent
during a turn.

- **Symptom:** reminders/scheduled work fire but never deliver to the chat, with
  no error logged (the callback runs, finds no chat id, and returns silently).
- **Cause:** the chat id was captured in `beforeTurn` into the sub-agent's
  `this.ctx.storage`, but the alarm callback runs in a different context and
  reads a different/empty store.
- **Rule:** capture everything a scheduled callback needs **at schedule time**
  (while the messenger context is live, via `agent.getMessengerContext()`) and
  carry it in the **schedule payload** — don't rely on `this.ctx.storage` to
  bridge a turn and its later alarm. See `set_reminder`/`propose_change`
  (`src/plugins/`) capturing `chatId` and `deliverReminder`/`runVerifiedChange`
  (`src/agent.ts`) reading it from the payload.

### Scheduled-alarm callbacks must never throw

A callback invoked from `this.schedule(...)` (e.g. `deliverReminder`,
`runVerifiedChange`) that throws makes the scheduler **retry its alarm on a
tight ~13s loop**, which jams the Durable Object — no chat replies, just
`_cf_dispatchScheduledCallback` + `canceled alarm` churn in the logs, and
(confusingly) often no exception surfaced. Wrap these callbacks (and anything
they await, like `sendTelegram`) in try/catch that logs and swallows. Dropping a
reminder is far better than wedging the bot.

### `beforeTurn` must not block on I/O

`beforeTurn` runs before the model produces any output. If it `await`s
something that hangs (e.g. a Durable Object `storage.put()` that stalls in the
sub-agent context), the reply turn produces no stream chunks, Think's stall
watchdog aborts it, and `chatRecovery` retries the same message every ~20s — so
the bot goes **completely silent with no error**.

- **Rule:** keep `beforeTurn` synchronous and cheap. Do any persistence
  fire-and-forget (`void this.ctx.storage.put(...).catch(...)`) so it can never
  block or fail the turn.

### Proactive messages don't reach Telegram via `saveMessages()`

Inbound replies use Think's streamed `chat()` delivery path. A turn started
programmatically with `saveMessages()` from an alarm is **not** delivered to the
messenger. For proactive sends (reminders, background results) call the Telegram
Bot API directly (`sendMessage`) with a known chat id — see `notifyUser` in
`src/agent.ts`.

### Telegram formatting: HTML via a local adapter patch

Replies render rich text via **HTML**, enabled by a local pnpm patch to
`@chat-adapter/telegram` (`patches/@chat-adapter__telegram.patch`, wired in
`pnpm-workspace.yaml`). The patch overrides the converter's `fromMarkdown` to
emit Telegram HTML (a port of `src/format.ts`) and makes `toBotApiParseMode`
send `parse_mode: HTML`. This unlocks entities MarkdownV2 didn't give us
(`tg-spoiler`, `tg-emoji`, expandable blockquote). The adapter still falls back
to plain text on any parse error, so a bad render degrades gracefully.

**Don't drop the patch** (`pnpm install` re-applies it; keep the `patches/`
file and the `pnpm-workspace.yaml` entry committed). If you bump the adapter
version, regenerate the patch (`pnpm patch @chat-adapter/telegram`). The model
emits Markdown; the adapter converts it — so format with normal Markdown, not
raw HTML.

True Rich Messages (`sendRichMessage` + `RichBlock*` layout, native tables)
remain out of scope — they need a new adapter send method and structured input
the LLM doesn't produce. HTML covers the rich-text cases.

### The bot holds no deploy/observability credential

Deploying tellboy and reading its logs go through the separate `tellboy-deployer`
Worker over a service binding (`env.DEPLOYER`, RPC). The bot only has that
binding; the Cloudflare/GitHub credentials live in the deployer's isolate. Never
put a Cloudflare API token (or a GitHub token with Actions scope) in the bot's
env — that would let the LLM-driven Worker bypass the control-plane boundary.
The deploy/logs targets are hard-coded in `deployer/src/index.ts`.
