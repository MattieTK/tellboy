# AGENTS.md

Notes for agents (and humans) working on tellboy. See `README.md` for setup,
`FEATURES.md` for what the bot can do, and `src/agent.ts` for the main wiring.

## Keep `FEATURES.md` current

`FEATURES.md` is the single user-facing description of what the bot can do, and
it is easy to let it rot. **When you add, remove, or materially change a
user-facing capability — a new plugin or tool, a new `ENABLE_*`/config flag, or
changed behaviour — update `FEATURES.md` in the same change**: the relevant
capability section *and* the config/flags reference table. This applies to
self-authored changes too — a `propose_change` that adds a tool should carry the
matching `FEATURES.md` edit. Purely internal changes (a refactor, or a bug fix
with no user-visible effect) need no doc update.

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

### External fetches in tools must have a timeout

A tool's `execute` runs inside the chat turn. A `fetch()` with no timeout that
hangs (slow Brave/GitHub response) hangs the tool, which stalls the turn. The
stall watchdog (`chatStreamStallTimeoutMs`, set to `STALL_TIMEOUT_MS` = 120s in
`agent.ts`) will eventually abort and recover it, but 120s is a long frozen-
looking gap — a per-fetch timeout fails fast instead. Always pass
`signal: AbortSignal.timeout(ms)` on outbound fetches in tools/turns and return a
clean error on failure, so the model can respond instead of hanging. See
`web_search` (`src/plugins/websearch.ts`) and `ghFetch` (`src/github.ts`).

### `beforeTurn` must not block on I/O

`beforeTurn` runs before the model produces any output. If it `await`s
something that hangs (e.g. a Durable Object `storage.put()` that stalls in the
sub-agent context), the reply turn produces no stream chunks. The stall watchdog
(now enabled, 120s) aborts it and `chatRecovery` resumes — but until that fires
the bot looks **silent with no error**, so still keep `beforeTurn` cheap.

- **Rule:** keep `beforeTurn` synchronous and cheap. Do any persistence
  fire-and-forget (`void this.ctx.storage.put(...).catch(...)`) so it can never
  block or fail the turn.

### Streaming liveness, capacity retries, and compaction are load-bearing

These three were added together after an incident where one message produced a
typing indicator, ~6.5 minutes of silence, then a capacity error (the prompt had
grown to ~40k tokens, every call was slow, and nothing retried or kept the user
informed). They interact — don't remove one in isolation:

- **Compaction must not no-op.** `configureSession` passes a per-message
  `tokenCounter` (`estimateMessageTokens`) to `createCompactFunction` and a wide
  `TAIL_TOKEN_BUDGET`. Without the counter, the default char heuristic
  under-counts tool-heavy history, the protected tail "covers" everything, the
  middle slice is empty, and compaction returns **null** (history never
  shortened). `COMPACT_AFTER_TOKENS` is 150k. The current default model has a
  much larger context window, but the threshold also bounds latency, cost and
  summarisation size; do not raise it without deliberately retesting compaction
  and between-turn growth. `contextOverflow.reactive` + `classifyChatError` are
  the overflow backstop.
- **Capacity errors must retry.** Workers AI throws `AiError 3040` unwrapped, so
  the AI SDK won't retry it. `buildModel()` wraps the model with
  `capacityRetryMiddleware` (match in `isTransientCapacityError`), covering both
  the streamed chat path and every `generateText()` path. Build all models
  through `buildModel()` so the retry can't be bypassed (the original bug:
  `summarize()` built its own un-retried model).
- **The user must never see dead air.** `RichTelegramAdapter.streamRich`
  re-issues the Telegram typing action every `TYPING_KEEPALIVE_MS` (under
  Telegram's ~5s clear) and shows the running tool as a transient draft
  (`beforeToolCall` sets `toolStatus`; the messenger `status` provider reads it).
  Both are best-effort and torn down in a `finally`.

### Proactive messages don't reach Telegram via `saveMessages()`

Inbound replies use Think's streamed `chat()` delivery path. A turn started
programmatically with `saveMessages()` from an alarm is **not** delivered to the
messenger. For proactive sends (reminders, background results) call the Telegram
Bot API directly (`sendMessage`) with a known chat id — see `notifyUser` in
`src/agent.ts`.

### Telegram formatting: Rich Messages, with HTML/MarkdownV2 fallback

Replies are delivered as **Bot API 10.1 Rich Messages** (`sendRichMessage`),
which render native tables, headings, ordered/task lists, blockquotes and
dividers — formatting the legacy parse modes can't express. The send side is
not the structured `RichBlock` tree it looks like: `InputRichMessage` carries
the body as a single `markdown` string, and Telegram's "Rich Markdown" *is*
GitHub Flavored Markdown — exactly what the model already emits. So the model's
reply passes through verbatim (`src/rich.ts`, `toInputRichMessage`); there is no
converter to maintain on the rich path.

Two delivery paths use it, both degrading gracefully (never throwing in the
alarm-driven path):

- **Streamed inbound replies** — `src/rich-adapter.ts` subclasses
  `@chat-adapter/telegram`'s `TelegramAdapter` and overrides `postMessage`
  (→ `sendRichMessage`) and `stream` (→ `sendRichMessageDraft` for the live
  animated preview, finalised via `sendRichMessage`). `richTelegramMessenger`
  wires it in via `chatSdkMessenger`, replacing Think's `telegramMessenger`.
  Because the base `stream()` finalises through `this.postMessage`, a failed
  rich draft still lands on a rich final message; a rejected rich send falls
  back to the base MarkdownV2 path.
- **Proactive sends** (reminders, selfdev results) — `notifyUser` in
  `src/agent.ts` tries `sendRichMessage`, then HTML (`src/format.ts`), then
  plain text.

`ENABLE_RICH_MESSAGES` is a kill switch (rich is **on by default**; set it to
`false`/`0`/`off` to force the HTML/MarkdownV2 path). `src/format.ts` remains as
the HTML fallback renderer — keep it and its tests.

History note: an earlier approach rendered HTML via a local pnpm patch to the
adapter (`patches/@chat-adapter__telegram.patch` + `pnpm-workspace.yaml`); it
was **reverted** (commit `91153d7`) and no longer exists. Don't reintroduce a
`dist` patch — the in-repo subclass in `rich-adapter.ts` is the supported
extension point (typed, no line-number coupling, covered by the test gate). If
you bump the adapter major version, re-check the handful of base-class internals
`rich-adapter.ts` reaches through `this.internals` (e.g. `telegramFetch`,
`resolveThreadId`, `parseTelegramMessage`) — the rich path try/catches into the
base, so a rename degrades rather than breaks, but fix it.

### The bot holds no deploy/observability credential

Deploying tellboy and reading its logs go through the separate `tellboy-deployer`
Worker over a service binding (`env.DEPLOYER`, RPC). The bot only has that
binding; the Cloudflare/GitHub credentials live in the deployer's isolate. Never
put a Cloudflare API token (or a GitHub token with Actions scope) in the bot's
env — that would let the LLM-driven Worker bypass the control-plane boundary.
The deploy/logs targets are hard-coded in `deployer/src/index.ts`.
