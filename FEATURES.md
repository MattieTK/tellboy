# tellboy — Features & What You Can Do

tellboy is a personal assistant you talk to in Telegram. It runs on your own
Cloudflare Workers account — one bot, one owner. You message it the way you'd
message a person, and it replies in the same chat.

A few things worth knowing up front about how it behaves:

- **You talk to it; it talks back.** Send a normal message (or a voice note) and
  it answers. No commands to memorise.
- **Each conversation has its own memory.** Every Telegram chat runs separately,
  with its own notes about you and its own history. What you tell it in one chat
  stays in that chat.
- **It can act on its own.** Reminders, automations, and daily briefings let it
  message you without you prompting first.

Every capability below is on by default unless its setup needs a token or key
you haven't added. You can turn anything off with the flags listed in each
section and in the reference table near the end.

---

## What you can do today

### Chat & formatting

Just talk to it. Replies come back as Telegram Rich Messages, so headings,
tables, ordered and task lists, blockquotes, code blocks, dividers and spoilers
all render natively. You don't do anything to get this — the bot writes Markdown
and Telegram renders it.

If a reply is too long for one rich message, or rich delivery fails for any
reason, it falls back to HTML and then to plain text rather than dropping the
message.

- **Try saying:** "Summarise this in a table" or "Give me a checklist for the
  release."
- **Model:** `@cf/deepseek-ai/deepseek-v4-flash-0731` by default, with reasoning,
  function calling and a 1,048,576-token context window. It requires Workers
  Paid or prepaid AI Gateway credits and can be replaced through `MODEL_ID`.
- **Flag:** `ENABLE_RICH_MESSAGES`, default on. Set to `false`/`0`/`off` to force
  the plain HTML/MarkdownV2 path.

### Reliability & recovery

The core agent runtime resumes interrupted chat turns and bounds failure loops so
a deploy, transient Durable Object restart, or memory-limit reset cannot leave a
conversation retrying forever. Memory-limit recovery has its own small retry
budget and an alarm-level circuit breaker; Tellboy's 120-second no-output
watchdog remains the faster backstop for a stalled model or tool.

The upgraded messenger runtime also preserves Telegram attachment identifiers
when a message is routed into its per-chat agent, so voice notes and other files
can still be fetched there. Streamed text on either side of a tool call retains
its word spacing instead of occasionally being joined together.

- **Flag:** none; these protections are part of the core agent runtime.

### Memory & personality

**Per-chat memory.** Each chat keeps a small, durable note of facts and
preferences you've shared (up to about 2,000 tokens). The bot updates it on its
own when you mention something durable, and you can edit it directly.

- **Try saying:** "Remember that I prefer short answers", "My company is Acme
  Corp", or "Clear my memory."
- The bot also compacts long conversations automatically: once a chat passes
  roughly 150,000 tokens, older messages are summarised into an overlay (the
  first couple of messages and the most recent stretch are kept verbatim). You
  don't manage this.
- **Flag:** on by default, part of the core agent.

**Personality / tone.** You can set a voice the bot keeps across conversations
until you change it. It defaults to a conservative professional tone.

- **Try saying:** "Talk in a warm, playful tone from now on", "Switch to a terse
  technical voice", or "Use the default voice again." Saying nothing (an empty
  instruction) clears it.
- The persona is capped at 600 characters and lives in the system prompt, so it
  never eats into the memory budget. Each chat can hold its own voice.
- **Flag:** `ENABLE_PERSONA`, default on.

### Reminders & automations

**Reminders** are one-off or recurring nudges the bot sends you at a set time.

- **Try saying:** "Remind me to check the deploy in 2 hours", "Set a reminder for
  tomorrow at 9am to review my PRs", or "Remind me every Monday at 8am about my
  standup."
- You can list pending reminders and cancel one by its id.
- **Flag:** `ENABLE_REMINDERS`, default on.

**Automations** go further: instead of a fixed message, you give the bot an
*instruction* to carry out at a future or recurring time. When it fires, the bot
runs the instruction as a full turn — using its tools — and sends you the result.

- **Try saying:** "Every Monday, list this week's reminders", "In 3 hours, check
  the logs and tell me if anything broke", or "Each morning at 6am, summarise my
  outstanding issues."
- **Tools:** `create_automation`, `list_automations`, `cancel_automation`.
- **Timing:** you give one of three — a relative delay (e.g. "in 2 hours"), a
  one-off absolute time, or a recurring schedule. List shows each automation's
  id, its instruction, when it next fires, and whether it recurs. Cancel by id.
- **Limits, honestly:** each automation run is capped at 8 tool steps, so it
  can't loop forever. If a run produces no output, you get an acknowledgement
  rather than a blank message. Errors during a run are swallowed (a failed run is
  dropped rather than retried) to avoid jamming the bot.
- **Flag:** `ENABLE_AUTOMATIONS`, default on.

### Proactive briefings

Set a daily briefing and the bot messages you each morning (or whenever you
choose) with the day's reminders, automations due, and any topics you've asked it
to watch.

- **Try saying:** "Send me a daily briefing at 8:30am London time", "Set up a
  09:00 morning brief in UTC", or "Turn off the briefing."
- **Tools:** `set_briefing`, `disable_briefing`.
- **Time and timezone:** give the time as 24-hour `HH:MM` (e.g. `08:30`) and a
  timezone as an IANA name (e.g. `Europe/London`, `America/New_York`); it
  defaults to UTC if you don't say. A time that can't be parsed, or an unknown
  timezone, comes back with a clear error rather than failing silently.
- **Setting a new briefing replaces the old one** — you won't end up with
  duplicates. Turning it off when none is set is safe and just tells you so.
- **DST caveat:** the schedule is a fixed cron, which can't follow daylight saving
  on its own, so a briefing pinned to a local time drifts by an hour across a DST
  change. Re-run `set_briefing` after the change to re-pin it.
- **Flag:** `ENABLE_BRIEFINGS`, default on.

### Voice

Send a voice note or audio clip and the bot transcribes it for you (Workers AI
Whisper, on the AI binding the bot already has — no extra setup). It echoes the
transcript back so you can catch any mis-hearing before it acts on what you said.

- **Try doing:** record a voice note instead of typing.
- **Limits:** only audio with no accompanying caption is transcribed; a voice note
  that already has a caption passes through as-is. If transcription fails (a
  download timeout, garbled audio), you get a short "couldn't transcribe — try
  again or type it" reply rather than a stall.
- **Flag:** `ENABLE_VOICE`, default on.

### Web search

Ask for current facts or a source link and the bot searches the public web via
Brave Search, returning title, URL and snippet per result.

- **Try saying:** "Search for recent news on Cloudflare Workers" or "What's the
  latest on AI safety regulations?"
- **Limits:** the search has a 10-second timeout so a slow response never stalls
  the chat; result count is between 1 and 10 (default 5).
- **Setup:** needs `BRAVE_API_KEY` (free tier available at
  <https://api-dashboard.search.brave.com/>), set on the bot Worker. Force on or
  off with `ENABLE_WEBSEARCH`.

### Weather

Ask for the weather and the bot reports current conditions for your saved
location — no key, no setup. Tell it where you are once and it remembers; after
that "what's the weather?" just works. You can also ask about anywhere else by
name.

- **Try saying:** "I'm in London" (to save it), "What's the weather?", or
  "What's the weather like in Tokyo?"
- **How it works:** `set_location` geocodes your place name (via the free,
  key-less Open-Meteo APIs) and stores it per-chat; `get_weather` then reads the
  forecast from Open-Meteo. Each chat keeps its own location. The saved place is
  also surfaced to the model, so it can use it for other location-aware asks
  without re-asking.
- **Limits:** every lookup has a 10-second timeout so a slow Open-Meteo response
  never stalls the chat; if no location is saved and you don't name one, the bot
  asks you to set one first.
- **Flag:** `ENABLE_WEATHER`, default on. No credential needed.

### Integrations via MCP

You can connect external Model Context Protocol (MCP) servers, and their tools
become available to the bot automatically — no hardcoded integration per service.

- **Setup:** set `MCP_SERVERS` to a JSON array of `{ name, url, apiKey? }`
  entries. On the next turn, each connected server's tools are part of the bot's
  toolset, and you use them by asking naturally.
- **Limits:** the bot waits at most 8 seconds for servers to connect each turn, so
  a slow or dead server degrades gracefully — the bot runs with whatever's ready.
  Authentication is Bearer-token (`apiKey`) only; OAuth-backed servers aren't
  supported (there's no interactive login flow for a single-user bot). Invalid
  entries (bad JSON, missing URL, non-HTTP(S)) are quietly dropped, and one broken
  server never breaks startup.
- **Flag:** `ENABLE_MCP` (explicit override). Defaults to on when `MCP_SERVERS` is
  set and parseable, off otherwise.

### Self-development

With a GitHub token configured, the bot can read its own code and improve itself
through pull requests.

**Read its own source.**
- **Try saying:** "Read `src/agent.ts`", "List the files in `src/plugins/`."
- **Tools:** `read_source`, `list_source`.

**Propose changes.** The bot can open a pull request against its own repo. Every
proposed change is first verified in a sandbox — clone, install, `pnpm
typecheck`, and `pnpm test` — and the PR only opens if both pass. Verification
runs off the chat turn and the result is sent to you when it's done.
- **Try saying:** "Add a tool to fetch stock prices", "Fix the bug in the deploy
  tool where…", or "Refactor the memory compaction logic."
- **Tool:** `propose_change`.

**Manage and merge its PRs.** It can list open PRs, squash-merge them (which
auto-deletes the branch and triggers CI), and close them.
- **Try saying:** "List my open PRs", "Merge PR #5 if it looks good", or "Close
  that PR, it's outdated."
- **Tools:** `list_pull_requests`, `merge_pull_request`, `close_pull_request`.
- **Scope guard:** merge and close only work on `bot/*` branches — the bot can
  never touch a human's PR.

**Self-authored plugins.** A new capability is a single TypeScript file under
`src/plugins/` exporting a plugin (name, an enable check, and a `tools()`
function), registered in `src/plugins/index.ts`. The bot writes one, ships it via
`propose_change`, and once verified you can ask it to merge.
- **Try saying:** "Add the ability to send emails" — the bot writes the plugin,
  proposes it, and asks for a merge once the sandbox passes.

**Request a deploy.** It can trigger a production deploy of the current `master`
branch, which re-runs typecheck and tests in CI before shipping.
- **Try saying:** "Deploy the latest changes."
- **Tool:** `request_deploy`. The bot never holds the deploy credential — it calls
  a separate deployer Worker over a binding (see the safety note below).

**Read its own logs.** It can read recent telemetry filtered by level and time
window, which is useful for debugging.
- **Try saying:** "Show me the errors from the last hour" or "Check for warnings
  in the last 10 minutes."
- **Tool:** `read_logs`. Window is 1–1,440 minutes (default 60); level is one of
  all/error/warn/info/log/debug (default all); limit is 1–200 events (default 50).

**Setup for all of the above:**
- `read_source`, `list_source`, `propose_change`, and PR management need
  `GITHUB_TOKEN` (a fine-grained PAT scoped to *only this repo*, with Contents and
  Pull requests read+write — and **not** Actions) plus `GITHUB_REPO` as
  `owner/name`. Propose-change also needs the Sandbox binding for verification.
  Force on or off with `ENABLE_SELFDEV` (auto-enabled when token and repo are
  both set).
- `request_deploy` and `read_logs` both need the `DEPLOYER` service binding.
  They are separate plugins: force `request_deploy` on or off with
  `ENABLE_DEPLOY`, and `read_logs` with `ENABLE_LOGS`.

---

## Config & flags reference

| Capability | Env var / secret | Default | What it unlocks |
| --- | --- | --- | --- |
| Chat model | `MODEL_ID` | `@cf/deepseek-ai/deepseek-v4-flash-0731` | Workers AI reasoning and tool-calling model (paid access required) |
| Chat & rich formatting | `ENABLE_RICH_MESSAGES` | on | Native tables, lists, headings, etc. (falls back to HTML/plain) |
| Turn recovery & attachment routing | core (no flag) | on | Bounded recovery from interrupted/OOM turns and durable per-chat attachment metadata |
| Per-chat memory | core (no flag) | on | Durable notes per chat + rolling compaction |
| Personality / tone | `ENABLE_PERSONA` | on | Persistent voice across conversations |
| Reminders | `ENABLE_REMINDERS` | on | One-off and recurring nudges |
| Automations | `ENABLE_AUTOMATIONS` | on | Scheduled instructions run as full turns |
| Daily briefings | `ENABLE_BRIEFINGS` | on | Proactive morning brief at a chosen time |
| Voice transcription | `ENABLE_VOICE` | on | Voice notes transcribed via Workers AI |
| Web search | `BRAVE_API_KEY` (secret) / `ENABLE_WEBSEARCH` | on when key set | Brave web search with source links |
| Weather | `ENABLE_WEATHER` | on | Current weather for a saved location (key-less Open-Meteo) |
| MCP integrations | `MCP_SERVERS` (var) / `ENABLE_MCP` | on when servers set | External MCP server tools auto-merged |
| Read source / open PRs | `GITHUB_TOKEN` (secret) + `GITHUB_REPO` (var) / `ENABLE_SELFDEV` | on when both set | Read code, propose & manage PRs, self-authored plugins |
| Request deploy | `DEPLOYER` binding / `ENABLE_DEPLOY` | on when bound | Trigger a production deploy via CI |
| Read own logs | `DEPLOYER` binding / `ENABLE_LOGS` | on when bound | Read recent telemetry by level and window |

The `ENABLE_*` flags accept falsy values (`false`/`0`/`off`) to switch a
capability off. Where a flag's default is "on when set", the capability switches
on once its token, var, or binding is present, and you can still force it on or
off explicitly.

---

## Not yet possible / on the roadmap

A few things people often ask for that the bot doesn't do today:

- **Gmail** — reading, searching, drafting or sending email. Not built in.
- **Google Calendar** — reading or creating events.
- **Proactive email / calendar monitoring** — e.g. "tell me when an important
  email arrives" or "warn me before back-to-back meetings."

The common blocker is Google OAuth: these need an interactive sign-in flow, and
the MCP gateway currently supports Bearer-token servers only. Adding Google
access means solving that login flow first. If you run your own MCP server that
handles Google auth and exposes a Bearer token, you could connect it today.

**Deliberate non-goals.** tellboy is single-user and Telegram-native by design.
Multi-channel delivery (Slack, web, SMS) and multi-tenant hosting (one
deployment serving many people) are not planned — keeping it to one owner on one
channel is what lets the memory model, the credential boundary, and the
self-modification gate stay simple.

---

## How it stays private & safe

- **Per-chat isolation.** Each Telegram chat is its own Durable Object with its
  own memory and history. One chat can't read another's notes.
- **Secrets stay out of the model's reach.** Tokens and keys live in the Worker's
  environment, not in anything the model sees. Self-authored plugins are required
  to gate on plain config flags or bindings the bot already has — never on a
  privileged credential.
- **A separate deployer holds the dangerous credentials.** The bot can deploy
  itself and read its logs, but it never holds a Cloudflare API token or a GitHub
  token with Actions scope. Those live in a separate `tellboy-deployer` Worker,
  reached over a private binding that can do exactly two things: deploy this bot
  and read this bot's logs.
- **Self-modification is gated by tests and CI, not trust.** A proposed change
  only becomes a PR if `pnpm typecheck` and `pnpm test` pass in a sandbox, and CI
  re-runs both before any merged change deploys. A malformed plugin can't ship.
- **Path guards.** The bot can only write inside the source tree. Proposed changes
  are refused for `.github/`, `deployer/`, `.git/`, absolute paths, and any path
  containing `..`. Merging and closing PRs is limited to `bot/*` branches, so the
  bot can never alter your CI config or touch a human's branch.
