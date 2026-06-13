# AGENTS.md

Notes for agents (and humans) working on tellboy. See `README.md` for setup and
`src/agent.ts` for the main wiring.

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

### Rich Messages (Bot API 10.1) are not reachable through the stack

`@chat-adapter/telegram` only calls `sendMessage`/`editMessageText` and supports
MarkdownV2 or plain — never HTML, and no `sendRichMessage` hook. Normal replies
already render as MarkdownV2 via the adapter. `src/format.ts` (markdown →
Telegram HTML) is only usable on the direct-send path where we bypass the
adapter. True Rich Messages would need an upstream change to the adapter/Think.

### The bot holds no deploy/observability credential

Deploying tellboy and reading its logs go through the separate `tellboy-deployer`
Worker over a service binding (`env.DEPLOYER`, RPC). The bot only has that
binding; the Cloudflare/GitHub credentials live in the deployer's isolate. Never
put a Cloudflare API token (or a GitHub token with Actions scope) in the bot's
env — that would let the LLM-driven Worker bypass the control-plane boundary.
The deploy/logs targets are hard-coded in `deployer/src/index.ts`.
