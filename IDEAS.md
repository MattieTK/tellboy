# tellboy — Ideas backlog

A curated backlog of capabilities the bot could grow next. This is a
brainstorm, not a commitment: each idea notes what it does, why it suits a
single-user Telegram assistant on Cloudflare Workers, and roughly how it'd be
built — as a **plugin** (`src/plugins/<name>.ts`, the same one-file contract
the bot already authors for itself), as an **MCP** server connected through the
existing gateway, or as a small **core** change. Prerequisites and honest
blockers are called out.

The existing capabilities (chat, rich formatting, per-chat memory, persona,
reminders, automations, briefings, voice, web search, weather, MCP, self-dev,
deploy, logs) are *not* re-listed here. Neither are the items already on the
roadmap in `FEATURES.md` (Gmail, Google Calendar, proactive email/calendar
monitoring — all blocked on a Google OAuth flow the MCP gateway can't host
today). The aim is to surface *more*.

A few cross-cutting principles that shape the picks below:

- **Prefer key-less or Bearer-token sources.** The bot's credential boundary
  is its best feature: it should never hold an interactive-OAuth login flow or
  an account-wide platform credential. Ideas that need interactive OAuth are
  marked and deferred to "solve the login flow first."
- **Per-chat state lives in the Durable Object.** Anything personal (a list, a
  habit log, a watchlist) stores in the chat's own DO SQLite — no shared DB,
  no per-user accounts, no cross-chat leakage.
- **Proactive sends reuse the scheduler.** Anything that should "tell me later"
  rides on the existing `schedule`/alarm + `notifyUser` path, not new
  plumbing.
- **Self-authorable.** Most of these are small enough that the bot could write
  the plugin itself via `propose_change` and ship it through the existing
  sandbox-verified PR flow. The backlog is also a menu for self-development.

---

## Information & retrieval

### 1. RSS / Atom feed watcher

Subscribe to a handful of feeds and get either on-demand digests ("what's new
on the Cloudflare blog?") or proactive alerts when a feed matches a keyword.

- **Why it fits:** pure HTTP, no key; proactive delivery reuses the scheduler;
  per-chat subscriptions live in DO storage. Pairs naturally with automations
  ("each morning, summarise new posts from these feeds").
- **How:** plugin with `add_feed` / `list_feeds` / `remove_feed` tools that
  store feed URLs, plus a fetch+parse (a tiny XML reader) used on demand or
  from a scheduled poll. `AbortSignal.timeout` on every fetch, as ever.
- **Prereq:** none.
- **Flag:** `ENABLE_FEEDS`, default on.

### 2. Summarise a link / long article

Paste a URL and the bot fetches the page, strips it to text, and returns a
concise summary (or a key-points list, or a translation).

- **Why it fits:** the model already summarises; the only missing piece is
  fetching + readability-extracting arbitrary HTML on the Worker. A 10s fetch
  timeout keeps a slow site from stalling the turn.
- **How:** plugin (`summarise_url`) — `fetch` the URL, strip tags to ~main
  content, hand the text to the model in the tool result. Consider a
  size cap (e.g. first ~12k chars) to protect the context window.
- **Prereq:** none (uses the existing `AI` binding for any optional
  pre-summarisation).
- **Flag:** `ENABLE_SUMMARISE`, default on.

### 3. Stocks & crypto prices

"What's AAPL at?" / "How's Bitcoin doing today?" with a chart-friendly table.

- **Why it fits:** free, key-less APIs exist (e.g. CoinGecko for crypto;
  several free quote endpoints for equities). Fits the rich-message table
  rendering the bot already does.
- **How:** plugin (`get_quote`) hitting a key-less endpoint; per-chat
  watchlist stored in DO so "my tickers" just works.
- **Prereq:** none for crypto; equities may need a free API key set as a
  secret (kept on the Worker, never model-visible).
- **Flag:** `ENABLE_MARKETS`, default on when no key needed.

### 4. Currency & unit conversion

Quick, deterministic conversions ("convert 250 GBP to JPY", "how many km in a
marathon") without leaning on the model's arithmetic.

- **Why it fits:** key-less FX (e.g. open exchange rates via a free endpoint),
  pure-math unit conversion. Cheap, exact, and a nice fallback when the model
  would otherwise guess.
- **How:** plugin, no credential; deterministic, no model call needed.
- **Flag:** `ENABLE_CONVERT`, default on.

### 5. GitHub activity digest

Given the bot already holds a `GITHUB_TOKEN` for self-dev, it can watch a
repo's issues/PRs and brief you: "what needs my review today?", "any new
issues on my repos since yesterday?"

- **Why it fits:** reuses the existing `src/github.ts` client and token; the
  token is repo-scoped already. A natural fit for the daily briefing and
  automations.
- **How:** plugin reusing `ghFetch`; tools to list open PRs awaiting your
  review, issues assigned to you, recent merges. Wire into briefing.
- **Prereq:** the same `GITHUB_TOKEN` + `GITHUB_REPO` self-dev needs.
- **Flag:** `ENABLE_GITHUB_DIGEST`, default on when self-dev is on.

---

## Personal data (per-chat, in the DO)

### 6. Lists & a scratchpad

A durable, structured scratchpad beyond the 2k-token memory block: shopping
lists, packing lists, ideas, "things to look at later". Add, tick off, clear.

- **Why it fits:** the memory block is for facts about you, not working lists;
  a separate structured store in the DO is the right shape and survives
  compaction. "Add milk to my shopping list" then "what's on my shopping list?"
  just works across turns.
- **How:** plugin storing named lists in DO storage; tools `list_add` /
  `list_remove` / `list_show` / `list_clear`.
- **Flag:** `ENABLE_LISTS`, default on.

### 7. Habit & streak tracker

Log a habit ("I went for a run", "didn't drink coffee today") and get streaks,
weekly summaries, and a nudge if you forget.

- **Why it fits:** per-chat DO storage is perfect for a personal log;
  reminders/automations already provide the nudge path. The model can interpret
  free-form logs into a structured entry.
- **How:** plugin (`log_habit`, `habit_report`) storing dated entries;
  optional automation to nag if a habit wasn't logged by a time.
- **Flag:** `ENABLE_HABITS`, default on.

### 8. Quiet hours / do-not-disturb

A window (e.g. 23:00–07:00, in your timezone) during which reminders and
briefings are held and batched into a morning digest instead of pinging you.

- **Why it fits:** purely a policy layer over the existing scheduler; the bot
  already knows your timezone from weather/briefings. Keeps the assistant from
  becoming a nuisance.
- **How:** core change to the delivery path (hold non-urgent scheduled sends
  during the window) + a plugin to set/clear the window. Existing urgent sends
  stay immediate.
- **Flag:** `ENABLE_QUIET_HOURS`, default on.

### 9. Memory export / backup

Export a chat's memory, persona, and saved data (lists, habits, location) as a
single Markdown/JSON file you can keep or move to another deployment.

- **Why it fits:** the data is already per-chat and self-contained; a one-shot
  export honours the "you own the deployment and the data" framing and is a
  trust builder.
- **How:** plugin that reads the relevant DO storage keys and returns a
  document; deliver as a Telegram message (or a file if file sends are added).
- **Flag:** `ENABLE_EXPORT`, default on.

---

## Telegram-native interactions

### 10. Image / photo understanding (vision)

The model is multimodal, but inbound photos are currently ignored. Let the bot
describe a photo, read a screenshot, OCR a receipt, or answer "what's in this
picture?"

- **Why it fits:** Kimi k2.6 is multimodal and already the default model; the
  gap is wiring the inbound photo into the turn (the same way voice is wired).
  Huge value-per-effort.
- **How:** core change mirroring `src/voice.ts` — accept inbound photo sizes,
  download the file, attach it as an image part to the turn. Gate with a flag.
- **Flag:** `ENABLE_VISION`, default on (no new credential; uses the `AI`
  binding's existing model).

### 11. Document / PDF ingestion

Send a PDF or text document and the bot reads, summarises, or answers
questions about it.

- **Why it fits:** extends the same inbound-file path as vision; a text/OCR
  extraction step keeps the context window sane for large docs.
- **How:** core change + extraction; chunk + (optionally) pre-summarise large
  docs before they hit the turn.
- **Flag:** `ENABLE_DOCS`, default on.

### 12. Inline-mode assistant

Answer Telegram inline queries so the bot helps in *other* chats: type
`@tellbot ...` in any chat to get a quick answer, translation, or lookup
without switching conversations.

- **Why it fits:** purely additive reach; uses the same model and tools, just
  a different entry point. Keeps the assistant at hand everywhere.
- **How:** core change to handle the `inline_query` update kind and return
  `answerInlineQuery` results. State would be ephemeral (inline answers don't
  carry the per-chat memory), which is acceptable for quick lookups.
- **Flag:** `ENABLE_INLINE`, default off (opt-in).

---

## Proactive & automation enhancements

### 13. Digest / batch mode

Instead of every reminder/automation firing as its own message, batch
low-priority notifications into a periodic digest ("since this morning: 3
reminders fired, 1 feed update").

- **Why it fits:** a single-user assistant can get chatty; a digest mode is a
  usability win and reuses the scheduler. Pairs with quiet hours.
- **How:** a queue of pending notifications in DO storage + a scheduled flush,
  with per-notification priority (urgent fires immediately, the rest batches).
- **Flag:** `ENABLE_DIGEST`, default off.

### 14. Snooze a reminder interactively

When a reminder fires, reply "snooze 30 min" / "snooze till tomorrow" and the
bot reschedules it instead of you re-typing the reminder.

- **Why it fits:** a small, very human touch on top of the existing reminder
  machinery; turns a one-shot nudge into a lightweight workflow.
- **How:** plugin recognising a snooze reply to a recently-delivered reminder
  (matched on a short id in the message) and calling `schedule` again.
- **Flag:** `ENABLE_SNOOZE`, default on.

---

## Self-awareness & ops

### 15. Self health-check briefing

The bot already reads its own logs (`read_logs`). On a schedule it can report
its own health: error rate over the last day, whether the last deploy CI
passed, whether any tools are misconfigured.

- **Why it fits:** composes two existing capabilities (logs + automations);
  the bot observing itself is on-brand for a self-improving assistant.
- **How:** automation or briefing extension that runs `read_logs` and
  summarises; no new plugin strictly needed, but a small `health_check` tool
  would package it cleanly.
- **Prereq:** the `DEPLOYER` binding (already needed for `read_logs`).
- **Flag:** `ENABLE_HEALTH`, default on when `ENABLE_LOGS` is on.

### 16. Capability inventory / "what can you do?"

A first-class answer to "what can you do?" that reflects the *currently
enabled* tools (so it's honest after plugins are added or disabled), rather
than a hardcoded list.

- **Why it fits:** the plugin registry already knows what's enabled
  (`enabledPluginNames`); surfacing it keeps the bot's self-description from
  drifting as it grows.
- **How:** small core change or plugin that enumerates enabled tools and their
  descriptions into a rich-message table.
- **Flag:** none (part of core).

---

## Reach via MCP (connect, don't build)

These don't need new plugins — they need an MCP server the bot connects to
through the existing gateway. Listed because the MCP path is under-used today
and is the fastest route to several common asks:

- **Notion / Obsidian / Logseq** — read & append to your notes. A self-hosted
  MCP server exposing a Bearer token turns "add this to my daily note" into a
  working command.
- **Linear / Todoist / GitHub Projects** — task management without the bot
  owning a per-service integration.
- **Home Assistant** — "turn off the living room lights" via a local HA MCP
  server. Strong fit for a personal assistant; the bot just calls the tool.
- **A read-only database** (SQLite/Postgres over MCP) for "ask my own data"
  queries.

The common enabler for the OAuth-backed ones (Notion public API is Bearer, so
that works today; others vary) is the same Google-OAuth gap noted in
`FEATURES.md`: until the bot can host an interactive login, anything needing
user consent is out of reach. A self-hosted MCP server that handles its own
auth and exposes a static Bearer token is the workaround the bot already
supports.

---

## Deliberate non-ideas (kept out of scope)

- **Multi-channel delivery (Slack, web, SMS, email out).** Single-channel,
  Telegram-native is a design choice, not a limitation; broadening it breaks
  the simple memory + credential model.
- **Multi-tenant hosting.** One deployment, one owner. Listed in
  `FEATURES.md` as a non-goal.
- **A full GUI / dashboard.** The whole point is you talk to it; a web UI
  would duplicate the channel.
- **Account-wide platform credentials on the bot Worker.** Anything needing a
  Cloudflare API token or a GitHub Actions-scope token stays in the separate
  deployer or in CI, per the control-plane boundary.

---

## How a chosen idea actually ships

Any idea above that's a plugin follows the path the bot already uses on
itself, so the loop is closed end-to-end:

1. Write `src/plugins/<name>.ts` exporting a `Plugin` (name, `isEnabled`, and
   `tools()`), modelled on `src/plugins/reminders.ts` and the `Plugin` contract
   in `src/plugins/types.ts`.
2. Register it in the `REGISTRY` array in `src/plugins/index.ts`.
3. Add the new `ENABLE_<NAME>` env var (optional) to `src/env.d.ts` if it
   needs config or a secret.
4. Update `tests/plugins.test.ts`, which asserts the exact set of enabled
   plugins and tool names, or sandbox verification will fail.
5. Update `FEATURES.md` — the capability section *and* the config/flags
   reference table — in the same change (per `AGENTS.md`).
6. Ship via `propose_change`; the sandbox runs `pnpm typecheck` + `pnpm test`
   before the PR opens; review and merge deploys it.

The bot can drive steps 1–5 itself and hand you a verified PR — that's the
self-development loop this backlog is also meant to feed.
