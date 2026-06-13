# tellboy – build plan

A self-hostable, Telegram-native personal assistant running entirely on Cloudflare.
One person, one bot, one Durable Object instance that remembers you and streams its
replies as it thinks. Phase 1 is a pure-LLM responder; the architecture is laid so
tools (web, email, calendar) drop in later without rework.

A locally deployable alternative to hosted personal chatbots (Poke, ChatGPT-style
assistants), where you own the deployment and the data.

---

## Verification status (checked against live sources, 2026-06-12)

Every factual claim below was re-checked against primary sources by a fan-out of
research agents. Two things are worth knowing before you trust the rest:

- **The Cloudflare and Kimi claims verified strongly.** `@cloudflare/think`, the
  Agents SDK APIs, the Kimi model ids and pricing all corroborate across *multiple
  independent* primary sources (npm registry, HuggingFace model cards, blog.cloudflare.com,
  OpenRouter, plus secondary press). High confidence.
- **The Telegram streaming claims rest on a single source.** `sendMessageDraft`,
  "Bot API 9.5", and "Bot API 10.1 Rich Messages" appear verbatim on the genuine
  `core.telegram.org` (TLS/DNS authenticity confirmed), but **no reputable source outside
  telegram.org corroborates them** – every other hit is AI-content-farm spam or issues in
  non-notable repos. The neat monthly 9.3 → 9.5 → 10.1 cadence also doesn't match Telegram's
  historically irregular release pattern. Treat the Telegram method names/semantics as
  "verify live in the official API reference at implementation time," not as settled fact.

Legend used in the findings below: **[confirmed]**, **[corrected]**, **[refuted]**,
**[verify-live]**. Source URLs are collected under "Sources" at the end.

---

## Research findings that shape the design

State of the platforms as of 2026-06-12. These are the facts the architecture is built around.

### Telegram

- **`sendMessageDraft` exists but the version history and semantics in the original plan
  were wrong. [corrected, verify-live]** Per the official changelog the method was
  *introduced* in Bot API **9.3 (31 Dec 2025)**, and Bot API **9.5 (1 Mar 2026)** only
  "allowed all bots to use" it (lifting a restriction). The latest API on the changelog is
  **10.1 (11 June 2026)**, so 9.5 is several releases back.
- **`sendMessageDraft` is private-chat-only, ephemeral, and not edited by message id. [corrected]**
  The reference defines it as streaming "a partial message to a user while the message is being
  generated … the streamed draft is ephemeral and acts as a temporary 30-second preview – once
  the output is finalized, you must call `sendMessage` with the complete message to persist it.
  Returns *True* on success." Concretely:
  - It **returns `True`, not a `Message`** – you cannot edit a draft by message id.
  - It **requires a non-zero `draft_id`**; repeated calls with the same `draft_id` animate the update.
  - **Empty `text` shows a "Thinking…" placeholder**; `text` is 0–4096 chars.
  - The draft **does not persist** – the final `sendMessage` is mandatory, not optional.
- **Groups/topics still use `sendMessage` + `editMessageText`. [confirmed]** `sendMessageDraft`
  does not accept a group chat (its `chat_id` is documented as a *private* chat), so the
  edit-loop remains a required code path for groups/topics – framed as "the group/topic
  streaming path, rate-limited to ~1 update/sec," not as legacy.
- **The "no native table primitive" claim is now stale. [refuted, verify-live]** True for
  *classic* formatting (entities are limited to bold/italic/underline/strikethrough/spoiler/
  blockquote/inline-link/pre-code – no table), so `<pre>` was the conventional fallback. But
  Bot API 10.1 reportedly adds "Rich Messages" with native `RichBlockTable` / `RichBlockTableCell`
  primitives plus `sendRichMessage` and `sendRichMessageDraft`, and a `rich_message` parameter on
  `editMessageText`. If real, this partly obviates the hand-rolled "markdown → HTML, tables → `<pre>`"
  layer. (Subject to the single-source caveat above.)
- **MarkdownV2 escaping is real and fiddly. [confirmed]** Outside entities, the characters
  `_ * [ ] ( ) ~ \` > # + - = | { } . !` must be backslash-escaped, with nesting rules
  (pre/code can't contain other entities; blockquotes can't nest). HTML mode is usually easier
  to generate safely – a reason to prefer it in the formatting layer if staying on classic formatting.
- **Webhook delivery verified with the `X-Telegram-Bot-Api-Secret-Token` header. [confirmed exactly]**
  `setWebhook` takes a `secret_token` (1–256 chars, `A-Z a-z 0-9 _ -`) sent in that header on every
  request.
- **Flood limits (from the Bot FAQ). [confirmed]** ~1 message/sec per chat; ≤20 messages/min to a
  group; ~30 messages/sec for bulk broadcast (paid broadcasts raise this to ~1000/sec at 0.1 Stars/
  message). Breaching returns `429` with `retry_after`. Max message text is 4096 chars after entity
  parsing. These numbers, not a guessed 700 ms, should set the throttle.

### Kimi K2.7

- **`kimi-k2.7-code` is real and its specs check out. [confirmed]** Per Moonshot's HuggingFace
  model card it is a **1T-parameter MoE, 32B active, 384 experts (8 selected/token), 256K
  (262,144-token) context, "Modified MIT" licence, coding-focused, built on Kimi K2.6**, priced
  **$0.95/M input ($0.19/M cached) and $4.00/M output**. Released 2026-06-12. It is a
  coding-specialised model, not a general-chat model.
- **It IS on Workers AI today – the original "not yet" risk is resolved. [refuted → available]**
  Cloudflare added **`@cf/moonshotai/kimi-k2.7-code`** on 2026-06-12 (live model page + Day-0
  changelog: 262,144-token context, function-calling/reasoning/vision = yes, $0.95/$4.00 per M,
  $0.19/M cached). *Caveat:* its availability is corroborated only across Cloudflare's own surfaces
  (model page + changelog), not yet by third parties.
- **Workers AI Kimi catalogue, corrected. [corrected]** `@cf/moonshotai/kimi-k2.6`
  (added 2026-04-20) is the current **general flagship** (multimodal, reasoning, tool-calling,
  262,144 context, $0.95/$4.00 per M, $0.16/M cached). **`kimi-k2.5` is deprecated as of
  2026-05-30 and auto-aliased to k2.6** – it is no longer a live, independent choice, so the
  original "hosts … kimi-k2.5" framing is stale.
- **No Moonshot API key / external path is needed for either model we care about. [corrected]**
  Both k2.6 and k2.7-code are first-party `@cf/` Workers AI models, callable via the `env.AI`
  binding, REST `/ai/run`, or the OpenAI-compatible `/v1/chat/completions` endpoint, billed at
  normal Workers AI pricing. The plan's premise that some variant would require an external
  Moonshot key no longer applies.

### Cloudflare Agents SDK / Project Think

- **`@cloudflare/think` is a real, shipped package. [confirmed]** npm `@cloudflare/think`,
  latest **v0.9.0 published 2026-06-12** by "Cloudflare Inc.", source in `cloudflare/agents`
  under `packages/think`; "Project Think" is documented at
  `developers.cloudflare.com/agents/harnesses/think/`. You extend `Think<Env>` and implement at
  minimum `getModel()`; you may also override `getSystemPrompt()`, `getTools()`,
  `configureSession()`, and others. It owns the `streamText` loop, the agentic loop, tool
  execution, and message persistence – as claimed.
- **`getModel()` / `getSystemPrompt()` / `configureSession()` and `onChunk()` / `onChatResponse()`
  are all real. [confirmed]** `onChunk(ctx)` fires per streaming chunk (high-frequency,
  observational); `onChatResponse(result)` fires after the turn completes and the message is
  persisted.
- **"Agent Memory" needs disambiguating – the plan conflated two distinct systems. [corrected]**
  There are *two* real things, and they are not wired together the way the plan implies:
  1. **The Session layer** (what `configureSession()` actually configures): conversation history
     as tree-structured messages plus writable **"context blocks"** injected into the system
     prompt, with compaction and FTS5 search – **backed by the agent's own Durable Object SQLite**,
     not a separate hosted service. *This* is the two-layer model the plan describes.
  2. **Agent Memory (the managed product)**: a separate Cloudflare service (private beta, announced
     Apr 2026) that *extracts* structured items (Facts/Events/Instructions/Tasks) from conversations,
     dedupes and indexes them, and recalls on demand. It is wired via an `agent_memory` binding and
     explicit `ingest()` / `recall()` / `remember()` calls – **not** via `configureSession()`, and it
     does **not** auto-inject system-prompt blocks.
  For Phase 1/3 we want **(1) the Session context blocks** (DO-SQLite, no extra product). (2) is an
  optional later upgrade if recall-from-long-history becomes a need.
- **`configureSession()` runs once at startup and supersedes `getSystemPrompt()`. [new]** When it
  adds context blocks, the system prompt is built *from* those blocks and `getSystemPrompt()` becomes
  only the no-context-blocks fallback. Don't expect both to compose.
- **There is no "experimental" compatibility flag. [refuted]** Think needs only the standard
  `nodejs_compat` flag. The word "experimental" in the docs is an API-stability label on the
  package (pre-1.0), not a wrangler flag. Pin the version.
- **Peer-dependency reality. [new]** Think v0.9.0 peer-requires `agents >=0.16`, `ai ^6`, `zod ^4`,
  and `@chat-adapter/telegram ^4.29.0`, and exposes subpaths like
  `@cloudflare/think/messengers/telegram`. Target `ai` v6 and `zod` v4 (not v5/v3) to avoid install
  breaks. The lower-level alternative is `AIChatAgent` (from `@cloudflare/ai-chat`), where you wire
  `streamText` yourself and override `onChatMessage()` – do not attribute `onChatMessage` to `@cloudflare/think`.
- **Durable Object routing, corrected. [corrected]** The SDK does route each chat to its own DO
  instance, but: the helper signature is **`getAgentByName(env.TellboyAgent, chatId)`** – the first
  argument is the **DO namespace binding from `env`**, not the Agent class. Default routing converts
  the class name to kebab-case, so `TellboyAgent` maps to `/agents/tellboy-agent/{chatId}`, not
  `/agents/tellboy/...` (cosmetic here, since we reach the agent server-side via `getAgentByName`).
- **"Zero idle cost" is half right. [corrected]** Idle *compute* is zero via hibernation, but
  **SQLite storage is billed continuously** (~$0.20/GB-month after a 5 GB-month free allowance) and
  in-memory state is wiped on hibernation while durable storage persists. For a single-user bot the
  storage cost is negligible, but production Agents need the **Workers Paid plan** (SQLite-backed DOs),
  which qualifies the "free self-host" framing.

---

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Default model | **`@cf/moonshotai/kimi-k2.7-code`, swappable via `MODEL_ID` env var** | Honours the brief; k2.7-code is now confirmed available on Workers AI. **But note:** it is coding-specialised – for general chat, **`@cf/moonshotai/kimi-k2.6` is the better default** (general flagship). The env var makes this a one-line swap. Decide per "Decisions still needed". `kimi-k2.5` is deprecated/aliased – don't reference it. |
| LLM routing | **AI Gateway via the per-call `gateway` option on the Workers AI binding (`env.AI`)** | No external API key (binding requests are pre-authenticated). Caching, logging, rate-limit are config. **Fallback is *not* a binding-level flag** – cross-model/provider fallback needs a gateway *Dynamic Route* or the *Universal endpoint*. Start with `gateway.id: 'default'` (auto-creates on first request). |
| Telegram client | **grammY** (`webhookCallback(bot, 'cloudflare-mod')` on Workers) | Adapter is **`cloudflare-mod`** for a Module Worker (`export default { fetch }`); the bare `cloudflare` adapter is the legacy Service-Worker variant and will fail. `@grammyjs/types` 3.27.3 may already type the 9.5 methods, so the raw-transport shim may be unnecessary – check first. |
| Base class | **`@cloudflare/think`** (pin `^0.9`) | Maps directly onto the streaming-loop + memory requirement. Verified real. Only `nodejs_compat` required; package is pre-1.0, so pin it. |

> **Build note (superseded the grammY decision).** During implementation, reading the installed
> `@cloudflare/think` types showed Think ships a **native Telegram messenger**
> (`getMessengers()` + `telegramMessenger()` from `@cloudflare/think/messengers/telegram`, backed by
> `@chat-adapter/telegram`) that already owns the webhook, secret-token verification, **live token
> streaming** (it edits the message in place), 4096-char splitting, per-thread isolation, and
> interruption recovery. The build adopted this ("Path A") instead of hand-wiring grammY, so the
> grammY rows below (`src/telegram.ts`, `@grammyjs/*`, the `cloudflare-mod` adapter, the hand-rolled
> streaming/throttle layer) are **superseded** – grammY is no longer a dependency. Default model is
> `@cf/moonshotai/kimi-k2.6`. The Worker entry also adds an auth guard so only the secret-verified
> webhook reaches the agent DO. See `README.md` and `src/agent.ts` for the shipped design.

---

## Architecture

```
Telegram  ──webhook(POST + secret-token header)──▶  Cloudflare Worker (fetch handler)
   ▲                                                      │ verify X-Telegram-Bot-Api-Secret-Token
   │                                                      │ parse update
   │ sendMessageDraft(draft_id) [private]                 │ getAgentByName(env.TellboyAgent, chatId)
   │ sendMessage+editMessageText [groups]                 ▼
   │ + final sendMessage to persist               TellboyAgent  (Durable Object, extends Think)
   └──────────────────────────────────────────┐    ├─ configureSession() → Session context blocks (DO SQLite)
                                               │    ├─ getModel() → workers-ai-provider/env.AI.run({gateway:{id}})
            Telegram formatting layer  ◀───────┘    ├─ getSystemPrompt()  (fallback if no context blocks)
            (markdown → Telegram HTML,                └─ onChunk() → throttled push to Telegram
             tables → <pre> or RichBlockTable)             │  onChatResponse() → finalise persisted message
                                                           ▼
                                          AI Gateway ──▶ Workers AI: @cf/moonshotai/kimi-k2.6 / k2.7-code
                                          (cache, logging, rate-limit; fallback = Dynamic Route/Universal)
```

### Components

| Component | File | Responsibility |
|---|---|---|
| Worker entry | `src/index.ts` | Receive webhook, verify `X-Telegram-Bot-Api-Secret-Token` (set the **same** secret in `setWebhook` *and* `webhookCallback`), parse update, route via `getAgentByName(env.TellboyAgent, chatId)`, respond 200 fast |
| `TellboyAgent` | `src/agent.ts` | Extends `Think`; owns conversation, Session context blocks, model, system prompt. One DO instance per chat. State is SQLite-backed (`new_sqlite_classes` migration) |
| Telegram client | `src/telegram.ts` | grammY `Bot` + `webhookCallback(bot, 'cloudflare-mod')`; pass `botInfo` from a `BOT_INFO` env var to avoid a `getMe` per cold start; `bot.api.raw` shims only for genuinely untyped methods |
| Streaming bridge | within `src/agent.ts` | Maps Think `onChunk` → throttled Telegram draft/edit updates with a per-`draft_id` scheme; `onChatResponse` → final `sendMessage`. Consider `@grammyjs/stream` instead of hand-rolling |
| Formatting layer | `src/format.ts` | model markdown → Telegram HTML (prefer HTML over MarkdownV2); tables → `<pre>` (or `RichBlockTable` if Rich Messages prove real); safe escaping |
| Config | `wrangler.jsonc`, `.dev.vars` | DO binding + **`new_sqlite_classes`** migration, **`nodejs_compat`** flag (no "experimental" flag), `"ai": { "binding": "AI" }`, `MODEL_ID` + `AI_GATEWAY_ID` + secrets |
| Setup script | `scripts/register-webhook.ts` | `setWebhook` with secret token – makes "deploy your own" one command |

---

## Streaming approach (core mechanic)

1. Update arrives → `sendChatAction("typing")` immediately. **Re-issue it every ~4 s** while
   generating, because the typing status auto-clears after ~5 s. Then start the Think turn.
2. Each `onChunk` appends to a buffer. A throttle decides when to push, tied to Telegram's
   documented **~1 update/sec per-chat** ceiling rather than a guessed interval:
   - **Draft path (private):** flush every ~700–1000 ms or ~120–200 new chars, *and only if*
     `@grammyjs/auto-retry` is enabled to absorb the inevitable `429`s.
   - **Edit path (groups/topics):** floor of **~1000–1500 ms** (plus the char threshold). `editMessageText`
     shares the same per-chat flood envelope, so it must be more conservative.
3. Private chat → flush via `sendMessageDraft` with a stable non-zero `draft_id` (same id animates).
   Group/topic → first flush is `sendMessage`, later flushes are `editMessageText` on that message id.
4. On `onChatResponse` (turn complete) → run the buffer through the formatting layer and **send a real
   `sendMessage`** to persist (mandatory for the draft path – the draft never persists). Split at the
   **4096-char** limit across multiple messages.

**Build-vs-buy:** `@grammyjs/stream` (v1.0.1) already implements draft animation, 4096-char splitting,
and finalisation-to-`sendMessage`, and is designed to consume an AI-SDK token stream; `@grammyjs/auto-retry`
honours `retry_after`; `@grammyjs/transformer-throttler` enforces the ceiling proactively. Evaluate these
before hand-rolling the bridge – they remove most of the bespoke code in `src/agent.ts` / `src/telegram.ts`.
The throttle *policy* (smoothness vs flood-control vs cost) remains a good Phase 2 tuning exercise even if
the plumbing is a plugin.

---

## Memory

`configureSession()` wires the **Session layer** – conversation history plus writable **context
blocks** injected into the system prompt – persisted in the per-chat Durable Object's SQLite (Phase 1
uses history; Phase 3 adds context-memory blocks). Because the DO instance is keyed per chat, memory is
naturally scoped to one user with no extra plumbing. This is *not* the managed "Agent Memory" product;
that separate service (extract/recall pipeline, `agent_memory` binding) is an optional later upgrade,
wired via explicit `ingest()`/`recall()` calls, not `configureSession()`.

---

## Phased plan

- **Phase 0 – scaffold & deploy a stub.** Worker + `agents` + `@cloudflare/think`;
  `wrangler.jsonc` with DO binding + `new_sqlite_classes` migration + `nodejs_compat`; grammY wired to
  the webhook with the `cloudflare-mod` adapter and the secret-token check; webhook-registration script.
  Deploy; bot echoes a fixed reply. Proves the Telegram → Worker → reply loop and the self-host flow.
- **Phase 1 – LLM responder (stated goal).** AI Gateway + Workers AI binding, `getModel()` pointed at
  the `MODEL_ID` env var (start `@cf/moonshotai/kimi-k2.6` for general chat, or k2.7-code per the brief),
  system prompt, conversation memory on. Bot answers from the model. No streaming yet.
- **Phase 2 – streaming + rich formatting.** `onChunk` → draft/edit bridge with throttle (per numbers
  above); formatting layer for HTML + tables. Live typing and rich text/tables.
- **Phase 3 – tools (later).** `getTools()` with web search, then Gmail/Calendar via MCP;
  Session context-memory writes (and optionally the managed Agent Memory product). Additive on the Think
  base class.

---

## Known risks

1. **`kimi-k2.7-code` Workers AI availability – RESOLVED.** It is live on Workers AI as
   `@cf/moonshotai/kimi-k2.7-code` (2026-06-12). Residual caveat: corroborated only on Cloudflare's own
   surfaces so far. The `MODEL_ID` env var still makes the model swappable. No Moonshot API key needed.
2. **`k2.7-code` is coding-tuned, not general-chat.** Confirmed. For conversational quality prefer
   `@cf/moonshotai/kimi-k2.6` (general flagship). Trivial env-var swap. Reserve k2.7-code for any
   agentic-coding sub-feature.
3. **Telegram streaming methods – verify live.** `sendMessageDraft`/`sendRichMessageDraft` appear in
   the official reference but lack independent corroboration (see "Verification status"). Before Phase 2,
   re-confirm the method exists and check `@grammyjs/types` coverage; if it's absent or behaves
   differently, fall back to the `editMessageText` throttle path (which is required for groups anyway).
   Cover `draft_id` and the mandatory final `sendMessage` in any raw-transport shim.
4. **Think is experimental (pre-1.0).** API may shift; pin `@cloudflare/think@^0.9` and the `agents`/`ai`/
   `zod` peers. (Only `nodejs_compat` is required – there is no experimental compatibility flag.)
5. **grammY adapter mismatch.** Use `'cloudflare-mod'` for a Module Worker; `'cloudflare'` is the legacy
   Service-Worker variant and will not work with `export default { fetch }`. This is the single most likely
   concrete bug to ship from the plan as originally written.
6. **Workers Paid plan required.** SQLite-backed Durable Objects / Agents need the paid plan in production,
   and storage (not compute) is the residual idle cost – small for a single user, but the "entirely free
   self-host" framing should acknowledge it.

---

## Open items to confirm before/at each phase

- Phase 1: **largely resolved.** Model id is `@cf/moonshotai/kimi-k2.6` (general) or `…/kimi-k2.7-code`
  (coding); wrangler AI binding is just `{ "ai": { "binding": "AI" } }`; the gateway id is passed in code
  via the `gateway` option (start with `'default'`). Add an `AI_GATEWAY_ID` env var defaulting to `'default'`.
  Confirm whether Think's `getModel()` expects a Vercel-AI-SDK `LanguageModel` (favours
  `createWorkersAI({ binding: env.AI, gateway: { id } })`) or calls `env.AI.run` directly.
- Phase 2: confirm `@grammyjs/types` already types `sendMessageDraft` (3.27.3 reportedly does) before
  writing a raw shim; decide build-vs-buy on `@grammyjs/stream`; finalise the throttle numbers; handle the
  30 s draft-expiry if first-token latency is high.
- Phase 3: choose web-search provider and MCP servers for Gmail/Calendar; decide whether to adopt the
  managed Agent Memory product or stay on Session context blocks.

---

## Decisions still needed (your call)

1. **General-chat default model:** stick with `kimi-k2.7-code` per the brief, or default to
   `kimi-k2.6` (general flagship) and keep k2.7-code as the swappable option? Recommendation: **k2.6 default**,
   k2.7-code via env var, because the assistant is conversational.
2. **Streaming posture given the Telegram single-source caveat:** design Phase 2 around `sendMessageDraft`
   (best UX if real), or design defensively on the `editMessageText` throttle path (works regardless, required
   for groups) and treat drafts as a progressive enhancement? Recommendation: **build the edit path first,
   layer drafts on top** once verified live.
3. **Build vs buy the streaming bridge:** adopt `@grammyjs/stream` + `@grammyjs/auto-retry`, or hand-roll the
   draft/edit throttle? Recommendation: **adopt the plugins**, keep throttle tuning as the bespoke part.

---

## Sources

**Telegram:** core.telegram.org/bots/api · /bots/api-changelog · /bots/api#sendmessagedraft ·
/bots/api#sendchataction · /bots/faq · grammy.dev/advanced/flood · grammy.dev/plugins/stream ·
grammy.dev/plugins/auto-retry · grammy.dev/plugins/transformer-throttler ·
grammy.dev/hosting/cloudflare-workers-nodejs · github.com/grammyjs/grammY (frameworks.ts, webhook.ts, api.ts) ·
npmjs.com/package/@grammyjs/types

**Kimi / Workers AI models:** huggingface.co/moonshotai/Kimi-K2.7-Code (model card) ·
platform.kimi.ai/docs/pricing · openrouter.ai/moonshotai/kimi-k2.7-code ·
developers.cloudflare.com/workers-ai/models/kimi-k2.7-code/ · …/kimi-k2.6/ · …/kimi-k2.5/ ·
developers.cloudflare.com/changelog/post/2026-06-12-kimi-k2-7-code-workers-ai/ · …/2026-04-20-kimi-k2-6-workers-ai/ ·
…/2026-05-08-planned-model-deprecations/

**Project Think / Agents SDK / DO:** registry.npmjs.org/@cloudflare/think (v0.9.0) ·
blog.cloudflare.com/project-think/ · developers.cloudflare.com/agents/harnesses/think/ (+ /configuration/, /lifecycle-hooks/) ·
developers.cloudflare.com/agents/runtime/lifecycle/sessions/ · …/api-reference/calling-agents/ ·
developers.cloudflare.com/durable-objects/platform/pricing/ · …/reference/durable-objects-migrations/

**Agent Memory (managed product):** blog.cloudflare.com/introducing-agent-memory/ ·
developers.cloudflare.com/agent-memory/ (+ /concepts/how-agent-memory-works/, /api/http-api/)

**AI Gateway:** developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/ ·
…/usage/providers/workersai/ · …/configuration/fallbacks/ · …/usage/universal/ ·
…/integrations/worker-binding-methods/ · github.com/cloudflare/ai/tree/main/packages/workers-ai-provider
