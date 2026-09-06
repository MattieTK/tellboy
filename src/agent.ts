import {
  Think,
  Session,
  defaultContextOverflowClassifier,
  type TurnContext,
  type TurnConfig,
  type ChatResponseResult,
  type ChatErrorClassification,
  type ToolCallContext,
  type ToolCallResultContext,
} from "@cloudflare/think";
import { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
import { createCompactFunction, estimateMessageTokens } from "agents/experimental/memory/utils";
import { createWorkersAI } from "workers-ai-provider";
import {
  generateText,
  stepCountIs,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
  type ToolSet,
} from "ai";
import { getSandbox } from "@cloudflare/sandbox";
import { collectTools } from "./plugins";
import { envFlag } from "./plugins/types";
import { PERSONA_KEY, composePersona } from "./plugins/persona";
import {
  LOCATION_KEY,
  locationPromptSegment,
  type StoredLocation,
} from "./plugins/weather";
import { TTT_GAME_KEY, type TicTacToeGame } from "./plugins/tictactoe";
import { connectMcpServers, MCP_CONNECT_TIMEOUT_MS } from "./plugins/mcp";
import type { ReminderPayload } from "./plugins/reminders";
import type { AutomationPayload } from "./plugins/automations";
import type { BriefingPayload } from "./plugins/briefings";
import type { VerifiedChangePayload } from "./plugins/selfdev";
import { getDefaultBranch, openPullRequest, type GitHubConfig } from "./github";
import { formatForTelegram, type TelegramParseMode } from "./format";
import { RICH_MESSAGE_CHAR_LIMIT, toInputRichMessage } from "./rich";
import { richTelegramMessenger } from "./rich-adapter";

// Whether to deliver replies as Bot API 10.1 Rich Messages. On by default; set
// ENABLE_RICH_MESSAGES to a falsy value ("false"/"0"/"off") as a kill switch.
// Every rich send degrades to the HTML/MarkdownV2 path on failure, so this only
// chooses which format is attempted first.
function richMessagesEnabled(env: Env): boolean {
  return envFlag(env, "rich_messages") ?? true;
}

// Whether to transcribe inbound voice/audio notes. The AI binding is always
// present, so this is on by default; set ENABLE_VOICE to a falsy value to turn
// it off (voice notes then pass through untranscribed). No new credential — it
// runs on the existing env.AI binding.
function voiceEnabled(env: Env): boolean {
  return envFlag(env, "voice") ?? true;
}

// Cap noisy command output before it goes into a chat message.
function truncate(text: string, max = 1500): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n… (truncated)` : t;
}

// Wrap command output in a fenced block so format.ts renders it as <pre>.
function codeBlock(text: string): string {
  return `\`\`\`\n${truncate(text)}\n\`\`\``;
}

// Single-quote a string for `sh -c` so titles with spaces/quotes are safe.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Durable-storage key for the Telegram chat id captured during inbound turns,
// used to deliver proactive messages (reminders, selfdev results).
const TG_CHAT_KEY = "tg_chat_id";

// Durable-storage key for the timestamp of the last inbound turn. Used to
// detect a session gap (see SESSION_GAP_MS): when the user comes back after a
// long pause, the conversation is explicitly re-framed as a new session in the
// system prompt instead of silently continuing the old one.
const LAST_TURN_KEY = "last_turn_at";

// The messenger encodes Telegram thread ids as "telegram:<chatId>[:<topicId>]"
// (see @chat-adapter/telegram encodeThreadId). Parse out the real chat id (and
// forum topic) for direct Bot API sends — using the raw value as chat_id gets
// a "chat not found" 400.
function parseTelegramThread(providerThreadId: string): {
  chatId: string;
  messageThreadId?: number;
} {
  const parts = providerThreadId.split(":");
  if (parts[0] === "telegram" && parts.length >= 2) {
    return {
      chatId: parts[1],
      messageThreadId: parts[2] ? Number(parts[2]) : undefined,
    };
  }
  // Fallback: an already-bare id.
  return { chatId: providerThreadId };
}

// --- Compaction policy ---------------------------------------------------
//
// This is the tier that keeps per-message input tokens bounded the way Poke
// does it: instead of replaying the whole transcript every turn, older
// messages are folded into a rolling summary once the conversation crosses a
// token threshold. Three numbers define the policy:
//
//   COMPACT_AFTER_TOKENS  When to compact. Auto-checked after each appended
//                         message; once the estimated prompt size exceeds this,
//                         the middle of the history is summarised into an
//                         overlay. Lower = leaner prompts but lossier memory and
//                         more frequent (paid) summarisation calls.
//   PROTECT_HEAD          How many of the FIRST messages to keep verbatim. The
//                         opening turns often carry framing the model should not
//                         lose (who the user is, the task they set up).
//   TAIL_TOKEN_BUDGET     How much of the most RECENT history (in tokens) to
//                         protect from summarisation — the full-fidelity recent
//                         window. Larger = more verbatim recency, higher tokens.
//
// These are the load-bearing trade-off of the whole feature, so they are set
// in one place. Tune them to taste; see the contribution request below for the
// summarise() implementation that turns the compacted middle into the summary.
//   The default model has a 1,048,576-token context window, so we keep history
//   verbatim far longer than the old 12k threshold, which forced lossy,
//   tool-heavy summarisation on every short conversation and — because the
//   default char heuristic under-counts tool JSON — kept returning null, so
//   history was never actually shortened). 150k remains conservative for
//   latency and cost while leaving ample room for a single between-turns turn
//   to grow (compaction is only checked between turns). The wide
//   TAIL_TOKEN_BUDGET guarantees a non-empty middle to summarise so compaction
//   can't no-op.
const COMPACT_AFTER_TOKENS = 150_000;
const PROTECT_HEAD = 2;
const TAIL_TOKEN_BUDGET = 40_000;

// --- Session gaps ---------------------------------------------------------
//
// Back-and-forth conversation over minutes/hours is ONE context: the model
// keeps the thread. But a message after a long pause (overnight, next morning,
// after the weekend) is a NEW session: the prior exchange's framing — and
// especially its implicit "now" — must not leak into it. The failure this
// fixes: "remind me tomorrow morning" sent just after midnight resolved
// against a stale in-context date and scheduled the reminder two days out.
//
// SESSION_GAP_MS is the threshold: below it the conversation continues as-is;
// at or above it, beforeTurn() injects a NEW SESSION block into the system
// prompt stating when the previous conversation ended and instructing the
// model to treat this as fresh context and re-anchor all dates to the current
// timestamp. 4h separates "an afternoon of chat" from "came back later/next
// day" without firing on a long lunch break.
const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

// Stall watchdog. Think leaves this at 0 (disabled) by default, which is why a
// hung or over-capacity model call left the user on a dead typing indicator
// with no error: the stream never produced a chunk and nothing aborted it.
// With a value set, a turn that emits no UI-stream chunk (model token OR tool
// activity) for this long is aborted and routed to chatRecovery instead of
// parking forever. Set comfortably above the slowest model time-to-first-token
// and the slowest in-turn tool (the sandbox build runs off-turn, so in-turn
// tools are web_search/MCP/GitHub reads — all AbortSignal.timeout-bounded).
const STALL_TIMEOUT_MS = 120_000;

// Retry policy for transient Workers AI capacity errors (e.g.
// "AiError: 3040: Capacity temporarily exceeded"). workers-ai-provider rethrows
// the raw AiError unwrapped, so the AI SDK never classifies it as retryable and
// the turn dies on the first refusal. We retry it ourselves via a
// wrapLanguageModel middleware (below), which covers BOTH the streamed chat()
// path and the generateText() paths (summaries, automations, briefings) that
// reuse getModel(). Capacity errors are thrown before the stream yields its
// first chunk, so retrying here can never double-send a partial reply. Backoff
// is exponential with full jitter; worst case ~15s, well under STALL_TIMEOUT_MS.
const CAPACITY_RETRY = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 8_000 } as const;

// Re-export so Think's messenger sub-agent routing can resolve the Chat SDK
// state facet (agents/chat-sdk). Production apps do not need a separate DO
// binding/migration for this facet-only class.
export { ThinkMessengerStateAgent };

// Name of the single root agent instance that owns Telegram ingress.
//
// routeAgentRequest addresses agents at /agents/<kebab-class>/<instance>/...,
// so the request the root agent sees keeps that full prefix. The Chat SDK
// messenger runtime matches its webhook route with an EXACT pathname compare
// (definition.path === url.pathname), so `path` below must be the full
// prefixed pathname, not the bare "/messengers/telegram/webhook" default.
//
// register-webhook.ts builds the same URL from this same instance name, so the
// two stay in sync. There is one root instance because all messenger traffic
// flows through a single Chat SDK runtime; per-chat memory still comes from the
// per-thread sub-agents (see `conversation` below).
export const ROOT_INSTANCE = "tellboy";

// kebab-case of the class name, used as the routeAgentRequest namespace segment.
// Exported so the Worker entry can allow exactly this path through its auth guard.
export const WEBHOOK_PATH = `/agents/tellboy-agent/${ROOT_INSTANCE}/messengers/telegram/webhook`;

// Is this model error a transient capacity/rate-limit/upstream blip worth
// retrying, as opposed to a deterministic failure (bad request, context
// overflow) or a deliberate abort (stall watchdog, turn cancellation)? We match
// on the message because workers-ai-provider rethrows the raw AiError without a
// typed `isRetryable` flag; the numeric code / HTTP status are best-effort.
function isTransientCapacityError(err: unknown): boolean {
  const e = err as
    | { name?: string; message?: string; code?: unknown; statusCode?: unknown; status?: unknown }
    | undefined;
  // Never retry an abort/cancel/timeout — that's the watchdog or the user.
  if (/abort|cancel|timeout/i.test(String(e?.name ?? ""))) return false;
  const msg = String(e?.message ?? err ?? "");
  // Context overflow is deterministic; retrying the same prompt fails the same
  // way. The reactive context-overflow backstop (which recompacts first)
  // handles that case instead.
  if (/prompt is too long|context (length|window)|maximum context|too many tokens/i.test(msg)) {
    return false;
  }
  const status = Number(e?.statusCode ?? e?.status ?? NaN);
  return (
    e?.code === 3040 ||
    [408, 429, 500, 502, 503, 504].includes(status) ||
    /\b3040\b|capacity temporarily exceeded|temporarily (overloaded|unavailable)|overloaded|rate.?limit(?:ed)?|too many requests|try again later|service unavailable/i.test(
      msg,
    )
  );
}

// LanguageModel middleware that retries transient capacity errors with
// exponential backoff + full jitter. Wraps both doGenerate and doStream; the
// retry happens before the stream resolves (capacity errors throw up-front), so
// a partially-streamed reply is never re-sent.
function capacityRetryMiddleware(policy: {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}): LanguageModelMiddleware {
  const run = async <T>(fn: () => PromiseLike<T>): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt >= policy.maxAttempts || !isTransientCapacityError(err)) throw err;
        const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
        const delay = ceiling / 2 + Math.random() * (ceiling / 2); // full jitter
        console.warn(
          `tellboy: transient model error, retrying (attempt ${attempt}/${policy.maxAttempts}, ~${Math.round(delay)}ms):`,
          String((err as Error)?.message ?? err),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastErr;
  };
  return {
    specificationVersion: "v3",
    wrapGenerate: ({ doGenerate }) => run(doGenerate),
    wrapStream: ({ doStream }) => run(doStream),
  };
}

// Friendly "what I'm doing right now" label for a tool call, shown as a
// transient Telegram draft during the turn (replaced by the streamed answer) so
// the user sees progress through tool gaps instead of dead air. Unknown tools
// get a generic label rather than nothing.
function toolStatusLabel(toolName: string): string {
  const labels: Record<string, string> = {
    web_search: "🔍 Searching the web…",
    read_source: "📖 Reading my source…",
    list_source: "📂 Looking through my source…",
    propose_change: "🛠️ Verifying and proposing a change…",
    list_pull_requests: "🔁 Checking my pull requests…",
    merge_pull_request: "🚀 Merging and deploying…",
    close_pull_request: "🔁 Updating a pull request…",
    set_reminder: "⏰ Setting that reminder…",
    list_reminders: "⏰ Checking your reminders…",
    set_automation: "🤖 Setting up that automation…",
    list_automations: "🤖 Checking your automations…",
    set_briefing: "🗞️ Setting up your briefing…",
    set_context: "🧠 Noting that for next time…",
    set_persona: "🎭 Updating my tone…",
    play_tic_tac_toe: "🎮 Playing tic-tac-toe…",
  };
  return labels[toolName] ?? `⚙️ Working on \`${toolName}\`…`;
}

export class TellboyAgent extends Think<Env> {
  // Hide chain-of-thought from Telegram. The configured model can reason;
  // we let it reason internally (see reasoning_effort below) but do not stream
  // those chunks into the conversation, which keeps replies clean. Set as a
  // class field (not in onStart) because Think reads it per turn; flip to true
  // if you want the reasoning surfaced.
  sendReasoning = false;

  // Wait (briefly) for connected MCP servers' tools to be ready before each
  // turn's inference loop — Think auto-merges those tools into the toolset. The
  // timeout is a hard cap so a slow or dead MCP server can never stall a turn:
  // Think proceeds with whatever tools have connected by then. When no MCP
  // server is configured this is harmless (nothing to wait for). See
  // src/plugins/mcp.ts and connectMcpServers() in onStart.
  waitForMcpConnections = { timeout: MCP_CONNECT_TIMEOUT_MS };

  // Abort and recover a turn that goes silent (no model token or tool activity)
  // for this long, instead of leaving the user on a dead typing indicator. Think
  // defaults this to 0 (off); see STALL_TIMEOUT_MS. chatRecovery is on by
  // default, so a tripped watchdog resumes the turn rather than dropping it.
  chatStreamStallTimeoutMs = STALL_TIMEOUT_MS;

  // Reactive backstop for the gap between compaction checks (compaction only
  // runs between turns; a single long, tool-heavy turn can still grow past the
  // window). On a context-overflow error, Think discards the partial, runs
  // session.compact(), and re-runs the turn from the compacted history. Pairs
  // with classifyChatError below. With the 150k threshold + working compaction
  // this should rarely fire, but without it an overflow would die silently —
  // exactly the failure class we're removing.
  contextOverflow = { reactive: true };

  // True while a chat turn (and its streamed reply) is in progress. Out-of-band
  // messages (reminders, selfdev results) are queued during this window so they
  // don't interrupt or cut off the streaming reply — see enqueueOrSend.
  private turnActive = false;

  // Messages deferred while a reply was streaming; flushed in onChatResponse.
  private outboundQueue: Array<{ text: string; chatId?: string }> = [];

  // In-memory cache of the user's chosen persona/tone, loaded once in onStart
  // (which can await) so getSystemPrompt() — a synchronous getter Think calls
  // per turn — can read it without blocking on storage. `undefined` means "not
  // set", which composePersona() turns into the conservative default voice.
  private persona: string | undefined;

  // In-memory cache of the user's saved location, loaded once in onStart so
  // the synchronous getSystemPrompt() can surface it (so the model knows where
  // the user is for weather and other location-aware asks) and the weather
  // tools can read it without a per-turn storage round-trip. `undefined` means
  // "not set".
  private location: StoredLocation | undefined;

  // The friendly label of the tool currently executing this turn (set in
  // beforeToolCall, cleared in afterToolCall and at turn boundaries). The rich
  // adapter reads it via the `status` provider passed in getMessengers() to show
  // a transient "doing X…" draft during tool gaps. `null` means no active tool.
  private toolStatus: string | null = null;

  // Timestamp (epoch ms) of the previous inbound turn, cached in memory and
  // persisted to storage (LAST_TURN_KEY). Used by beforeTurn() to detect a
  // session gap (SESSION_GAP_MS) and re-frame the conversation as a new
  // session. `undefined` means "unknown" — first ever turn, or a DO evicted
  // since the last message before onStart reloaded it — which beforeTurn()
  // treats conservatively as a gap (fresh framing can only help there).
  private lastTurnAt: number | undefined;

  getModel(): LanguageModel {
    // sessionAffinity is a stable key so a conversation's turns hit the same
    // backend replica and benefit from prefix caching. reasoning_effort "low"
    // keeps latency/cost modest while preserving some reasoning (hidden because
    // sendReasoning is false). buildModel adds the capacity-retry middleware.
    return this.buildModel({ reasoningEffort: "low", sessionAffinity: this.sessionAffinity });
  }

  // Build the chat model with the shared capacity-retry middleware applied, so
  // every model call — the streamed inbound reply and the generateText() paths
  // (summaries, automations, briefings) — retries transient capacity errors the
  // same way. Defined in one place so the retry policy can't drift between
  // paths (the previous bug: summarize() built its own un-retried model).
  private buildModel(opts: {
    reasoningEffort: "low" | "medium" | "high" | null;
    sessionAffinity?: string;
  }): LanguageModel {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: { id: this.env.AI_GATEWAY_ID },
    });
    const base = workersai(this.env.MODEL_ID, {
      sessionAffinity: opts.sessionAffinity,
      reasoning_effort: opts.reasoningEffort,
    });
    return wrapLanguageModel({ model: base, middleware: capacityRetryMiddleware(CAPACITY_RETRY) });
  }

  // Map a model error to a class Think can act on. We only assert
  // "context_overflow" (via the framework's classifier), which arms the reactive
  // backstop above; capacity/transient errors are already handled by the
  // retry middleware, so we leave those unclassified (undefined) here.
  classifyChatError(error: unknown): ChatErrorClassification | undefined {
    return defaultContextOverflowClassifier(error);
  }

  // Load the durable persona/tone into the in-memory cache once at boot, so the
  // synchronous getSystemPrompt() can honour it without a per-turn storage read.
  // onStart can await (it runs inside partyserver's blockConcurrencyWhile), but
  // a throw here is terminal (it retry-loops the DO init), so the read is
  // best-effort: on any failure we keep `undefined` and fall back to the
  // conservative default voice. Call super in case the base does init work.
  async onStart(props?: Record<string, unknown>): Promise<void> {
    await super.onStart?.(props);
    try {
      this.persona = await this.ctx.storage.get<string>(PERSONA_KEY);
      this.location = await this.ctx.storage.get<StoredLocation>(LOCATION_KEY);
      // Reload the previous turn's timestamp so session-gap detection survives
      // DO eviction. If this read fails the cache stays `undefined`, which
      // beforeTurn() treats as a gap — safe degradation.
      this.lastTurnAt = await this.ctx.storage.get<number>(LAST_TURN_KEY);
    } catch (e) {
      console.error("tellboy: persona load failed (using default)", String(e));
    }
    // Connect any configured MCP servers (integrations gateway). Fire-and-forget
    // so a slow/dead server can't stall boot — the per-turn
    // waitForMcpConnections cap bounds how long a turn waits for the tools, and
    // connectMcpServers swallows per-server failures internally. A throw here
    // would retry-loop the DO init, so the whole call is also guarded.
    void connectMcpServers(this, this.env).catch((e) =>
      console.error("tellboy: MCP connect failed (swallowed)", String(e)),
    );
  }

  // Read the cached persona/tone. Synchronous so tools and the prompt getter
  // can use it without awaiting.
  getPersona(): string | undefined {
  return this.persona;
  }

  // Durably set (or, with `undefined`, clear) the user's persona/tone. Writes
  // to per-thread DO storage and updates the in-memory cache so the next turn's
  // getSystemPrompt() reflects it immediately. Called from the `set_persona`
  // tool, which runs inside a chat turn (not an alarm), so awaiting the write
  // here is fine — unlike beforeTurn, this is not on the no-output path.
  async setPersona(persona: string | undefined): Promise<void> {
    this.persona = persona;
    if (persona === undefined) {
      await this.ctx.storage.delete(PERSONA_KEY);
    } else {
      await this.ctx.storage.put(PERSONA_KEY, persona);
    }
  }

  // Read the cached saved location. Synchronous so getSystemPrompt() and the
  // weather tools can use it without awaiting; the durable value is reloaded
  // in onStart.
  getLocation(): StoredLocation | undefined {
    return this.location;
  }

  // Durably set (or, with `undefined`, clear) the user's saved location. Writes
  // to per-thread DO storage and updates the in-memory cache so the next turn's
  // getSystemPrompt() reflects it immediately. Called from the `set_location`
  // tool, which runs inside a chat turn (not an alarm), so awaiting the write
  // here is fine.
  async setLocation(location: StoredLocation | undefined): Promise<void> {
    this.location = location;
    if (location === undefined) {
      await this.ctx.storage.delete(LOCATION_KEY);
    } else {
      await this.ctx.storage.put(LOCATION_KEY, location);
    }
  }

  // Resolve the live Telegram chat target (chat id + optional forum topic) for
  // a direct Bot API send from within a chat turn — used by plugins that need
  // to post interactive content (e.g. the tic-tac-toe board with buttons) the
  // streamed-reply path can't express. Returns undefined when no messenger
  // context is live (e.g. an alarm callback). Mirrors the chat-id capture the
  // reminders plugin does, but parsed for a direct send.
  currentTelegramTarget(): { chatId: string; messageThreadId?: number } | undefined {
    const thread = this.getMessengerContext()?.thread.providerThreadId;
    return thread ? parseTelegramThread(thread) : undefined;
  }

  // The active per-chat tic-tac-toe game, if any (one game at a time per chat).
  // Stored on the per-thread sub-agent so each chat keeps its own game; the
  // button-action turn routes to the same sub-agent, so the storage is
  // consistent between a move played here and the next button tap.
  async getTicTacToeGame(): Promise<TicTacToeGame | undefined> {
    return await this.ctx.storage.get<TicTacToeGame>(TTT_GAME_KEY);
  }

  async setTicTacToeGame(game: TicTacToeGame | undefined): Promise<void> {
    if (game === undefined) {
      await this.ctx.storage.delete(TTT_GAME_KEY);
    } else {
      await this.ctx.storage.put(TTT_GAME_KEY, game);
    }
  }

  getSystemPrompt(): string {
    // Base instructions. Once the `memory` context block (below) accumulates
    // facts, those are layered on top of this prompt. The persona/tone segment
    // is composed from the user's cached choice (or a conservative default when
    // unset) — it rides in the system prompt, not the 2k-token memory block, so
    // it never crowds the memory budget.
    const segments = [
      "You are Tellboy, a personal assistant that talks to one person over Telegram.",
      composePersona(this.persona),
      "Be concise and direct. Prefer short answers; expand only when asked.",
      "Always present replies as well-structured Telegram Rich Messages — Markdown renders natively, so use the full GitHub-Flavored Markdown vocabulary by default instead of plain prose. Structure every non-trivial answer with the richest fitting layout: ## headings to separate sections, GFM | tables | for any comparison, set of options, or attribute/value data, bullet or numbered lists (nested for sub-points) for steps and collections, > blockquotes to set off quoted or key text, `inline code` and ```fenced blocks``` for code, paths and commands, ||spoilers|| for surprises, and --- dividers between major sections. Default to a heading/table/list structure whenever the content has any structure to it, and prefer that over a wall of text. Only a genuinely trivial reply — a yes/no or a single value — should be left plain.",
      "When the user shares a durable fact about themselves (preferences, names, ongoing projects, recurring tasks), remember it in your memory so future replies stay consistent.",
      "You can inspect, improve, and ship your own code. Use read_source/list_source to read your source; propose_change to open a pull request with a fix or improvement (it is verified by typecheck and tests in a sandbox before the PR opens); list_pull_requests to see your open proposals; and merge_pull_request to merge one of your own once it's ready (merging deploys it). When asked to fix or improve yourself, use these tools rather than claiming you cannot modify your own code.",
      "Your tools are not fixed: when the user asks for a capability you currently lack, you can give yourself that capability by AUTHORING a new plugin, then shipping it the same way you ship any other change. A plugin is a single file, src/plugins/<name>.ts, that exports a Plugin — a `name`, an `isEnabled(env)` check (auto-enable from prerequisites with an ENABLE_<NAME> override via envFlag), and a `tools(agent, env)` function returning AI SDK tools — registered by adding one entry to the REGISTRY array in src/plugins/index.ts (and importing it there). Read src/plugins/reminders.ts as the canonical example and src/plugins/types.ts for the Plugin contract first, and match the existing conventions: env-gated enablement via envFlag, tools that return a clean { error } object instead of throwing, AbortSignal.timeout on any outbound fetch. tests/plugins.test.ts asserts the exact set of enabled plugins and tool names, so if your plugin adds a tool or changes that set, update those expectations in the same change or sandbox verification will fail. Ship with propose_change (it runs pnpm typecheck AND pnpm test in a sandbox before the PR opens, so a malformed plugin never ships), then list_pull_requests and merge_pull_request to deploy. Prefer building a real, tested plugin over telling the user a capability is impossible.",
      "Constraints when authoring a plugin: you may only write inside the source tree — propose_change refuses paths under .github/, deployer/, or .git/, absolute paths, and any path containing '..', so keep changes to src/, tests/, and similar. Do not add a powerful credential (a Cloudflare API token, or a GitHub token with Actions scope) to wrangler.jsonc or env.d.ts; a plugin gates on plain config flags or bindings it already has. Keep beforeTurn-style work cheap and non-blocking, and capture anything a scheduled/alarm callback needs at schedule time — such callbacks must never throw.",
      "If you are unsure or lack information, say so plainly rather than guessing.",
    ];
    const locSegment = locationPromptSegment(this.location);
    if (locSegment) segments.push(locSegment);
    segments.push(
      "You can play tic-tac-toe with the user via the play_tic_tac_toe tool. " +
        "When the user taps a board button you receive a user message like " +
        "'Action selected: ttt_move' with a 'Value: N' line; N is the 0-based " +
        "cell. Respond by calling play_tic_tac_toe with action 'move' and " +
        "cell=N, then describe the result briefly — do not echo the raw " +
        "action text.",
    );
    return segments.join(" ");
  }

  // Tools the model can call this turn. Sourced from the plugin registry
  // (src/plugins): each plugin self-enables from env (an API key present, an
  // ENABLE_<NAME> flag), so enabling a capability is a config change, not a
  // code change here. Called at turn start, so it reflects the current env.
  getTools(): ToolSet {
    return collectTools(this, this.env);
  }

  // Per-turn system-prompt augmentation. The model needs the current time to
  // resolve absolute/recurring reminder times ("tomorrow at 9am"); we append
  // it here rather than as a cached context block so it stays fresh each turn.
  // The trade-off is a small prefix-cache cost — acceptable for a personal
  // assistant, and the live conversation below the system prompt still caches.
  beforeTurn(ctx: TurnContext): TurnConfig {
    // A reply is now streaming: hold out-of-band sends until it finishes so we
    // never interrupt/cut off the streamed message (see enqueueOrSend).
    this.turnActive = true;
    // Drop anything left from a turn that ended without onChatResponse (e.g.
    // aborted), so the queue can never get stuck and swallow future sends.
    this.outboundQueue = [];
    // No tool is running yet this turn; clear any stale status from a prior turn.
    this.toolStatus = null;
    // Best-effort capture of the Telegram chat id for proactive sends
    // (reminders, selfdev results read it from storage when they fire from an
    // alarm with no messenger context). This MUST NOT block or fail the turn:
    // an awaited storage write here can stall the reply turn (no stream chunks
    // → the stall watchdog aborts and chatRecovery retries forever). So it is
    // synchronous and fire-and-forget, with errors swallowed.
    try {
      const chatId = this.getMessengerContext()?.thread.providerThreadId;
      if (chatId) {
        void this.ctx.storage
          .put(TG_CHAT_KEY, chatId)
          .catch((e) => console.error("tellboy: chat-id capture failed", e));
      }
    } catch (e) {
      console.error("tellboy: beforeTurn capture error", e);
    }

    // --- Session-gap detection + date anchor -----------------------------
    //
    // Both jobs need the CURRENT wall clock and must never block the reply, so
    // they run synchronously off the in-memory lastTurnAt cache (persisted
    // fire-and-forget below, reloaded in onStart). The gap is measured from the
    // previous INBOUND turn — i.e. the last time the user actually spoke — so
    // reminder/automation callbacks firing overnight don't mask a real gap.
    const now = Date.now();
    const previous = this.lastTurnAt;
    const gapMs = previous === undefined ? undefined : now - previous;
    // Persist for the next turn (and for DO eviction). Fire-and-forget: an
    // awaited write here stalls the reply stream and trips the stall watchdog.
    this.lastTurnAt = now;
    void this.ctx.storage
      .put(LAST_TURN_KEY, now)
      .catch((e) => console.error("tellboy: last-turn persist failed", e));

    const nowDate = new Date(now);
    // Weekday + full timestamp: the model resolves "tomorrow", "this
    // morning", "next Friday" against THIS, never against dates it infers
    // from the conversation history (the two-days-out scheduling bug).
    const timeSegment =
      `Current time (UTC): ${nowDate.toISOString()} ` +
      `(${nowDate.toUTCString().slice(0, 3)}day). ` +
      "All date arithmetic — every relative date like 'today', 'tomorrow', " +
      "'this morning', 'next week' — MUST be resolved against this timestamp, " +
      "never against dates mentioned earlier in the conversation.";

    // A long pause (overnight, next morning, after the weekend) means the
    // prior exchange's framing no longer applies: say so explicitly. An
    // unknown previous turn (first message, or DO evicted before onStart
    // reloaded the timestamp) is treated as a gap too — fresh framing can only
    // help there.
    if (gapMs === undefined || gapMs >= SESSION_GAP_MS) {
      const hoursAgo =
        gapMs === undefined
          ? "an unknown time"
          : `${Math.round(gapMs / 3_600_000)}h ago`;
      const prevIso = previous === undefined ? "unknown" : new Date(previous).toISOString();
      const sessionSegment =
        `NEW SESSION: the previous conversation in this thread ended ` +
        `${prevIso} (${hoursAgo}), and this message arrives after a long ` +
        "pause. Treat this as fresh context: do not carry over assumptions, " +
        "tasks, or in-flight plans from the earlier exchange unless the user " +
        "references them. Re-anchor all dates and times to the current " +
        "timestamp above. If the user's message only makes sense with " +
        "earlier context, briefly restate what you understood and confirm, " +
        "rather than silently assuming.";
      return {
        system: `${ctx.system}\n\n${timeSegment}\n\n${sessionSegment}`,
      };
    }

    return { system: `${ctx.system}\n\n${timeSegment}` };
  }

  // Turn (and its streamed reply) is done: release the queue so any deferred
  // out-of-band messages go out now, after the reply — never during it.
  async onChatResponse(_result: ChatResponseResult): Promise<void> {
    this.turnActive = false;
    this.toolStatus = null;
    const queued = this.outboundQueue;
    this.outboundQueue = [];
    for (const m of queued) await this.notifyUser(m.text, m.chatId);
  }

  // Surface the running tool as a transient status while it executes (the rich
  // adapter shows it as a draft during the gap where no model text is flowing).
  // Returns void so the tool runs normally.
  beforeToolCall(ctx: ToolCallContext): void {
    this.toolStatus = toolStatusLabel(ctx.toolName);
  }

  // Tool finished — clear the status so the keep-alive falls back to a plain
  // typing indicator until the next tool or the model's text.
  afterToolCall(_ctx: ToolCallResultContext): void {
    this.toolStatus = null;
  }

  // Send a message, or queue it if a reply is currently streaming so it waits
  // for the stream to finish rather than racing/cutting it off.
  private async enqueueOrSend(text: string, chatId?: string): Promise<void> {
    if (this.turnActive) {
      this.outboundQueue.push({ text, chatId });
    } else {
      await this.notifyUser(text, chatId);
    }
  }

  configureSession(session: Session): Session {
    // Tellboy's memory is tiered to keep per-message input tokens bounded
    // (the Poke approach), rather than replaying the whole transcript:
    //
    //   Tier 1 — `memory` context block: durable facts the model self-edits
    //            via the `set_context` tool. Always injected, capped at 2000
    //            tokens so it cannot crowd out the live conversation.
    //   Tier 2 — rolling summary via onCompaction()/compactAfter(): older
    //            messages are compressed into a summary overlay once the
    //            conversation crosses COMPACT_AFTER_TOKENS. This is the tier
    //            that stops prompt size growing with conversation length.
    //   Tier 3 — recent window: the framework already replays only the last
    //            few messages at full fidelity (read-time truncation), and
    //            TAIL_TOKEN_BUDGET protects the recent span from compaction.
    //
    // withCachedPrompt() marks the system prompt + context blocks as cacheable
    // for prefix-cache reuse across turns.
    return session
      .withContext("memory", {
        description: "Durable facts, preferences, and context about the user",
        maxTokens: 2000,
      })
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) => this.summarize(prompt),
          protectHead: PROTECT_HEAD,
          tailTokenBudget: TAIL_TOKEN_BUDGET,
          // Per-message counter for the tail-budget boundary walk. Without it
          // the default char heuristic under-counts tool-heavy messages, the
          // protected tail "covers" the whole history, the middle slice comes
          // out empty, and createCompactFunction returns null — i.e. compaction
          // silently no-ops (the production failure). Reusing the framework's
          // own estimator keeps the boundary math consistent with the threshold.
          tokenCounter: (msgs) => estimateMessageTokens(msgs),
        }),
      )
      .compactAfter(COMPACT_AFTER_TOKENS)
      .withCachedPrompt();
  }

  // Turns the to-be-compacted slice of history into a single summary string.
  // createCompactFunction() builds the prompt (head/tail already protected and
  // boundary-aligned) and hands it here; we just need to run it through a
  // model and return the text. Reuses the chat model via getModel().
  private async summarize(prompt: string): Promise<string> {
    // Reuse MODEL_ID (no second model to configure) but disable reasoning:
    // compaction is a bounded, mechanical task — compress this slice while
    // preserving facts and recency — so chain-of-thought adds latency and cost
    // for no quality gain. This is the same provider as getModel() with
    // reasoning_effort turned off, and no sessionAffinity since compaction is
    // not part of the live conversation's prefix cache.
    const { text } = await generateText({
      // Built through the shared helper so summarisation inherits the
      // capacity-retry middleware too.
      model: this.buildModel({ reasoningEffort: null }),
      prompt,
    });
    return text;
  }

  // Called by the durable scheduler when a reminder set via the reminders
  // plugin comes due (see plugins/reminders.ts, REMINDER_CALLBACK). Public
  // because this.schedule() resolves the callback by method name.
  //
  // Injecting a message via saveMessages() triggers a normal model turn whose
  // reply is delivered to the user through the Telegram messenger — the same
  // proactive path Think's scheduled `prompt` tasks use. No chat id is needed:
  // this code runs on the per-thread Durable Object that owns the alarm, so it
  // already holds that conversation's messenger binding.
  async deliverReminder(payload: ReminderPayload): Promise<void> {
    // Swallow errors: a throw here makes the scheduler retry the alarm on a
    // tight loop, which jams the DO (see AGENTS.md). Better to drop a reminder
    // than to wedge the bot.
    try {
      console.log(
        "tellboy: deliverReminder fired",
        JSON.stringify({ hasChatId: payload.chatId !== undefined }),
      );
      await this.enqueueOrSend(`⏰ Reminder: ${payload.message}`, payload.chatId);
    } catch (err) {
      console.error("tellboy: deliverReminder failed (swallowed)", String(err));
    }
  }

  // Called by the durable scheduler when an automation set via the automations
  // plugin comes due (see plugins/automations.ts, AUTOMATION_CALLBACK). Public
  // because this.schedule() resolves the callback by method name.
  //
  // Where deliverReminder echoes a fixed message, an automation carries an
  // instruction the bot runs as a model turn — with its full toolset — then
  // delivers the result proactively through the same enqueueOrSend path as
  // reminders/selfdev. We run the turn with generateText() (the same provider
  // as getModel(), reusing the plugin toolset) rather than saveMessages(),
  // because a turn started via saveMessages() from an alarm is not delivered to
  // the messenger (AGENTS.md), whereas enqueueOrSend → notifyUser sends straight
  // to the captured chat id.
  async deliverAutomation(payload: AutomationPayload): Promise<void> {
    // Swallow errors: a throw here makes the scheduler retry the alarm on a
    // tight loop, which jams the DO (see AGENTS.md). Better to drop an
    // automation than to wedge the bot.
    try {
      console.log(
        "tellboy: deliverAutomation fired",
        JSON.stringify({ hasChatId: payload.chatId !== undefined }),
      );
      const { text } = await generateText({
        model: this.getModel(),
        tools: this.getTools(),
        // Let the model use its tools to complete the instruction, looping
        // through tool calls up to a bounded number of steps.
        stopWhen: stepCountIs(8),
        system: [
          this.getSystemPrompt(),
          `Current time (UTC): ${new Date().toISOString()}.`,
          "You are running a scheduled automation the user set up earlier. " +
            "Carry out the instruction below and reply with only the result " +
            "the user should see — no preamble about it being automated.",
        ].join("\n\n"),
        prompt: payload.instruction,
      });
      const result = text.trim();
      // An empty model turn (e.g. tool-only with no closing text) shouldn't
      // produce a blank message; fall back to acknowledging the run.
      const message = result
        ? `🤖 Automation: ${result}`
        : `🤖 Automation ran: ${payload.instruction}`;
      await this.enqueueOrSend(message, payload.chatId);
    } catch (err) {
      console.error(
        "tellboy: deliverAutomation failed (swallowed)",
        String(err),
      );
    }
  }

  // Called by the durable scheduler each day when a briefing set via the
  // briefings plugin comes due (see plugins/briefings.ts, BRIEFING_CALLBACK).
  // Public because this.schedule() resolves the callback by method name.
  //
  // Like deliverAutomation, this runs a model turn with the full toolset and
  // delivers the result proactively through enqueueOrSend → notifyUser (a turn
  // started via saveMessages() from an alarm is not delivered to the messenger;
  // AGENTS.md). The instruction is fixed: compile the day's brief. The model can
  // reach its reminders/automations via list_reminders/list_automations and any
  // watch topics via web_search, so it composes the brief from live state.
  async deliverBriefing(payload: BriefingPayload): Promise<void> {
    // Swallow errors: a throw here makes the scheduler retry the alarm on a
    // tight loop, which jams the DO (see AGENTS.md). Better to drop a briefing
    // than to wedge the bot.
    try {
      console.log(
        "tellboy: deliverBriefing fired",
        JSON.stringify({ hasChatId: payload.chatId !== undefined }),
      );
      const { text } = await generateText({
        model: this.getModel(),
        tools: this.getTools(),
        // Let the model gather state (reminders, automations, watch topics)
        // across a bounded number of tool-call steps before composing.
        stopWhen: stepCountIs(8),
        system: [
          this.getSystemPrompt(),
          `Current time (UTC): ${new Date().toISOString()}.`,
          "You are compiling the user's daily briefing, which the bot sends " +
            "unprompted. Compile and send the user's briefing: their " +
            "reminders and automations due today plus any topics they have " +
            "asked you to watch. Use your tools (e.g. list_reminders, " +
            "list_automations, web_search) to gather the live state, then " +
            "reply with only the brief the user should see — a short, " +
            "well-structured Rich Message. If there is nothing noteworthy, " +
            "say so briefly. No preamble about this being automated.",
        ].join("\n\n"),
        prompt:
          "Compile and send my briefing for today: reminders and automations " +
          "due today plus any watch topics.",
      });
      const result = text.trim();
      const message = result
        ? `🗞️ Daily briefing\n\n${result}`
        : "🗞️ Daily briefing: nothing noteworthy today.";
      await this.enqueueOrSend(message, payload.chatId);
    } catch (err) {
      console.error("tellboy: deliverBriefing failed (swallowed)", String(err));
    }
  }

  // Proactively message the user via the Telegram API directly. Used by the
  // scheduler callbacks (reminders, selfdev results), which run from an alarm
  // with no live messenger turn — so we cannot stream a reply through Think's
  // inbound delivery path. We send straight to the stored chat id instead,
  // which is the reliable provider-explicit way to push an unprompted message.
  private async notifyUser(text: string, chatId?: string): Promise<void> {
    // Prefer the chat id carried in the schedule payload (captured when the
    // messenger context was live); fall back to the stored id.
    const target = chatId ?? (await this.ctx.storage.get<string>(TG_CHAT_KEY));
    if (!target) {
      console.error("tellboy: no chat id (payload or stored); cannot deliver proactive message");
      return;
    }
    const { chatId: chat, messageThreadId: thread } = parseTelegramThread(target);
    console.log(
      "tellboy: proactive send",
      JSON.stringify({ chat, thread, fromPayload: chatId !== undefined }),
    );

    // Three-tier delivery, each tier the fallback for the one above:
    //   1. Rich Message (Bot API 10.1) — native tables/headings/lists from the
    //      model's own GFM, when enabled.
    //   2. HTML (format.ts) — escaped markdown/code blocks; ASCII tables.
    //   3. Plain text — last resort so a formatting edge case never drops a
    //      message (this path runs in alarm callbacks where silence is the bug).
    if (richMessagesEnabled(this.env)) {
      if (await this.sendTelegramRich(chat, thread, text)) return;
    }
    const html = formatForTelegram(text);
    const delivered = await this.sendTelegram(chat, thread, html.text, html.parseMode);
    if (!delivered) await this.sendTelegram(chat, thread, text);
  }

  // Send a proactive message as a Bot API 10.1 Rich Message (sendRichMessage).
  // The model's Markdown is passed through verbatim (Telegram's Rich Markdown is
  // GitHub Flavored Markdown), so tables/headings/lists render natively. Returns
  // false (never throws) on any failure so notifyUser can fall back — this runs
  // inside scheduled-alarm callbacks where a throw retry-loops and jams the DO.
  private async sendTelegramRich(
    chatId: string,
    threadId: number | undefined,
    markdown: string,
  ): Promise<boolean> {
    // Skip empty or over-limit bodies so we fall back instead of eating a 400.
    if (!markdown.trim() || markdown.length > RICH_MESSAGE_CHAR_LIMIT) return false;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      rich_message: toInputRichMessage(markdown),
    };
    if (threadId !== undefined) body.message_thread_id = threadId;

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendRichMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        console.error("tellboy: rich send failed", res.status, await res.text());
      }
      return res.ok;
    } catch (err) {
      console.error("tellboy: rich send threw", String(err));
      return false;
    }
  }

  private async sendTelegram(
    chatId: string,
    threadId: number | undefined,
    text: string,
    parseMode?: TelegramParseMode,
  ): Promise<boolean> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (threadId !== undefined) body.message_thread_id = threadId;
    if (parseMode) body.parse_mode = parseMode;

    // Never throw out of here: this runs inside scheduled-alarm callbacks, and
    // an uncaught throw makes the alarm retry on a tight loop (jamming the DO).
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        console.error("tellboy: Telegram send failed", res.status, await res.text());
      }
      return res.ok;
    } catch (err) {
      console.error("tellboy: Telegram send threw", String(err));
      return false;
    }
  }

  // Scheduler callback for the selfdev `propose_change` tool. Runs OFF the chat
  // turn (clone + install + typecheck is too slow to block a reply). Verifies
  // the proposed edit in a Sandbox container and only opens a PR if it passes
  // `pnpm typecheck`; the outcome is relayed to the user via notifyUser().
  //
  // PR-only by design — no merge — so a human review stays the gate.
  async runVerifiedChange(payload: VerifiedChangePayload): Promise<void> {
    // Deliver results to the chat captured when the change was proposed.
    const notify = (t: string) => this.enqueueOrSend(t, payload.chatId);
    const cfg: GitHubConfig = {
      token: this.env.GITHUB_TOKEN ?? "",
      repo: this.env.GITHUB_REPO ?? "",
    };
    if (!cfg.token || !cfg.repo) {
      await notify("I couldn't verify that change — GitHub isn't configured.");
      return;
    }

    const sandbox = getSandbox(this.env.Sandbox, "selfdev-builder");
    const repoDir = "/workspace/repo";
    // Token-bearing remote so both clone and push authenticate. The sandbox is
    // isolated and ephemeral, so the credential never leaves the container.
    const authUrl = `https://x-access-token:${cfg.token}@github.com/${cfg.repo}.git`;

    try {
      const base = await getDefaultBranch(cfg);
      console.log(
        "tellboy: runVerifiedChange start",
        JSON.stringify({ base, files: payload.files.length }),
      );

      // Never let git block on a credential/terminal prompt — that hangs the
      // whole verification with no error and no timeout. Force non-interactive.
      await sandbox.setEnvVars({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" });

      // Fresh checkout each run. Every step is time-bounded so nothing can hang
      // the run indefinitely (the earlier failure mode).
      await sandbox.exec(`rm -rf ${repoDir}`, { timeout: 30_000 });
      console.log("tellboy: cloning repo");
      await sandbox.gitCheckout(authUrl, {
        branch: base,
        targetDir: repoDir,
        depth: 1,
        cloneTimeoutMs: 90_000,
      });
      console.log("tellboy: cloned; applying files");
      await sandbox.exec(`git remote set-url origin ${authUrl}`, { cwd: repoDir, timeout: 15_000 });
      await sandbox.exec(`git config user.email "bot@tellboy.local"`, { cwd: repoDir, timeout: 15_000 });
      await sandbox.exec(`git config user.name "tellboy-bot"`, { cwd: repoDir, timeout: 15_000 });
      // Defence-in-depth: never run repo git hooks in the sandbox. Even if a
      // hook file slipped past unsafeProposedPaths (selfdev.ts), it must not
      // execute at commit/push time, where the token-bearing remote URL lives.
      await sandbox.exec(`git config core.hooksPath /dev/null`, { cwd: repoDir, timeout: 15_000 });

      // Apply the proposed files.
      for (const f of payload.files) {
        const full = `${repoDir}/${f.path}`;
        await sandbox.mkdir(full.slice(0, full.lastIndexOf("/")), {
          recursive: true,
        });
        await sandbox.writeFile(full, f.content);
      }

      // Install (warm pnpm store from the image keeps this fast) + typecheck.
      console.log("tellboy: pnpm install");
      const install = await sandbox.exec("pnpm install --frozen-lockfile", {
        cwd: repoDir,
        timeout: 240_000,
      });
      if (!install.success) {
        await notify(
          `I couldn't verify the change — \`pnpm install\` failed:\n${codeBlock(install.stderr || install.stdout)}`,
        );
        return;
      }
      console.log("tellboy: pnpm typecheck");
      const check = await sandbox.exec("pnpm typecheck", {
        cwd: repoDir,
        timeout: 180_000,
      });
      if (!check.success) {
        await notify(
          `The change does NOT pass \`pnpm typecheck\`, so I did not open a PR. Errors:\n${codeBlock(`${check.stdout}\n${check.stderr}`)}`,
        );
        return;
      }

      // Run the test suite — the behavioural gate that typecheck can't give.
      // A self-PR that compiles but breaks core logic is caught here, before a
      // PR exists (and the bot can merge it).
      console.log("tellboy: pnpm test");
      const test = await sandbox.exec("pnpm test", {
        cwd: repoDir,
        timeout: 180_000,
      });
      if (!test.success) {
        await notify(
          `The change passes typecheck but FAILS the tests, so I did not open a PR. Output:\n${codeBlock(`${test.stdout}\n${test.stderr}`)}`,
        );
        return;
      }

      // Commit + push a fresh branch.
      console.log("tellboy: tests passed; committing + pushing");
      const branch = `bot/${crypto.randomUUID().slice(0, 8)}`;
      await sandbox.exec(`git checkout -b ${branch}`, { cwd: repoDir, timeout: 30_000 });
      await sandbox.exec("git add -A", { cwd: repoDir, timeout: 30_000 });
      const commit = await sandbox.exec(
        `git commit -m ${shellQuote(payload.title)}`,
        { cwd: repoDir, timeout: 30_000 },
      );
      if (!commit.success) {
        await notify(
          "Nothing to commit — the proposed files match the current code.",
        );
        return;
      }
      const push = await sandbox.exec(`git push origin ${branch}`, {
        cwd: repoDir,
        timeout: 60_000,
      });
      if (!push.success) {
        await notify(
          `Verified, but the push failed:\n${codeBlock(push.stderr)}`,
        );
        return;
      }

      // Open the PR from here (Workers can't run git, but a REST call is fine).
      const pr = await openPullRequest(cfg, {
        title: payload.title,
        body: `${payload.body}\n\n---\n_Verified in a sandbox: \`pnpm typecheck\` and \`pnpm test\` passed._`,
        head: branch,
        base,
      });
      if ("error" in pr) {
        await notify(
          `Verified and pushed \`${branch}\`, but opening the PR failed: ${pr.error}`,
        );
        return;
      }
      await notify(
        `Verified (\`pnpm typecheck\` passed) and opened a PR for your review: ${pr.url}`,
      );
    } catch (err) {
      await notify(
        `That change errored during verification: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  }

  getMessengers() {
    return {
      // richTelegramMessenger is a drop-in for Think's telegramMessenger that
      // delivers Bot API 10.1 Rich Messages on the streamed reply path (native
      // tables/headings/lists from the model's GFM). It degrades to MarkdownV2
      // automatically, and the `rich` flag is a kill switch (ENABLE_RICH_MESSAGES).
      telegram: richTelegramMessenger({
        rich: richMessagesEnabled(this.env),
        // Lets the streamed-reply adapter surface the running tool as a
        // transient "doing X…" draft during tool gaps (see beforeToolCall).
        status: () => this.toolStatus,
        // Transcribe inbound voice/audio notes with Workers AI Whisper on the
        // existing env.AI binding (no new credential). The runner is passed in
        // here because env.AI is reachable from the agent but not the adapter.
        // The transcript becomes the turn's text and is echoed back so the user
        // can correct mis-hearings; on failure the note degrades to a plain
        // "couldn't transcribe" turn rather than blocking the bot.
        voice: voiceEnabled(this.env)
          ? {
              run: (model, input) =>
                this.env.AI.run(
                  model as Parameters<Env["AI"]["run"]>[0],
                  input as never,
                ),
            }
          : undefined,
        token: this.env.TELEGRAM_BOT_TOKEN,
        userName: this.env.TELEGRAM_BOT_USERNAME,
        // Verified back via the X-Telegram-Bot-Api-Secret-Token header on every
        // webhook delivery. The messenger throws in webhook mode if this is
        // unset and verifyWebhook is not explicitly false.
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET,
        // Must match the registered webhook URL's pathname exactly (see the
        // ROOT_INSTANCE comment above).
        path: WEBHOOK_PATH,

        // respondTo defaults to ["direct-message", "mention"] — private chats
        // and @mentions. For a personal 1:1 assistant that is what you want for
        // ordinary messages.
        //
        // "action" is also enabled so tappable inline-keyboard buttons (the
        // tic-tac-toe board) come back as turns: a button press arrives to the
        // model as an "Action selected: ttt_move / Value: N" user message, which
        // it relays to the play_tic_tac_toe tool as a move. No other message
        // type carries buttons here, so this only affects game play.
        //
        // To also handle group chats, add "subscribed-thread" to the array
        // below to react to ordinary messages in subscribed threads:
        //   respondTo: ["direct-message", "mention", "subscribed-thread", "action"],
        // Caveat: in groups, BotFather privacy mode (on by default) hides
        // non-command, non-mention messages from the bot. Either disable
        // privacy mode in BotFather (/setprivacy -> Disable) so the bot sees
        // all group messages, or rely on @mentions only.
        respondTo: ["direct-message", "mention", "action"],

        // conversation defaults to "thread": one Think sub-agent per Telegram
        // thread, so each chat keeps its own memory. Set conversation: "self"
        // to share a single memory across all chats instead.
        // conversation: "thread",
      }),
    };
  }
}
