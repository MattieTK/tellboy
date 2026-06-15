import {
  Think,
  Session,
  type TurnContext,
  type TurnConfig,
  type ChatResponseResult,
} from "@cloudflare/think";
import { defineMessengers, ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, type LanguageModel, type ToolSet } from "ai";
import { getSandbox } from "@cloudflare/sandbox";
import { collectTools } from "./plugins";
import { envFlag } from "./plugins/types";
import { PERSONA_KEY, composePersona } from "./plugins/persona";
import type { ReminderPayload } from "./plugins/reminders";
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
const COMPACT_AFTER_TOKENS = 12_000;
const PROTECT_HEAD = 2;
const TAIL_TOKEN_BUDGET = 4_000;

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

export class TellboyAgent extends Think<Env> {
  // Hide chain-of-thought from the Telegram chat. Kimi is reasoning-capable;
  // we let it reason internally (see reasoning_effort below) but do not stream
  // those chunks into the conversation, which keeps replies clean. Set as a
  // class field (not in onStart) because Think reads it per turn; flip to true
  // if you want the reasoning surfaced.
  sendReasoning = false;

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

  getModel(): LanguageModel {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: { id: this.env.AI_GATEWAY_ID },
    });
    return workersai(this.env.MODEL_ID, {
      // Stable key so a conversation's turns hit the same backend replica and
      // benefit from prefix caching.
      sessionAffinity: this.sessionAffinity,
      // Keep latency/cost modest for a chat assistant while preserving some
      // reasoning. Raise to "medium"/"high" for harder tasks, or set to null
      // to disable reasoning entirely. Output is hidden either way because
      // sendReasoning is false.
      reasoning_effort: "low",
    });
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
    } catch (e) {
      console.error("tellboy: persona load failed (using default)", String(e));
    }
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

  getSystemPrompt(): string {
    // Base instructions. Once the `memory` context block (below) accumulates
    // facts, those are layered on top of this prompt. The persona/tone segment
    // is composed from the user's cached choice (or a conservative default when
    // unset) — it rides in the system prompt, not the 2k-token memory block, so
    // it never crowds the memory budget.
    return [
      "You are Tellboy, a personal assistant that talks to one person over Telegram.",
      composePersona(this.persona),
      "Be concise and direct. Prefer short answers; expand only when asked.",
      "Always present replies as well-structured Telegram Rich Messages — Markdown renders natively, so use the full GitHub-Flavored Markdown vocabulary by default instead of plain prose. Structure every non-trivial answer with the richest fitting layout: ## headings to separate sections, GFM | tables | for any comparison, set of options, or attribute/value data, bullet or numbered lists (nested for sub-points) for steps and collections, > blockquotes to set off quoted or key text, `inline code` and ```fenced blocks``` for code, paths and commands, ||spoilers|| for surprises, and --- dividers between major sections. Default to a heading/table/list structure whenever the content has any structure to it, and prefer that over a wall of text. Only a genuinely trivial reply — a yes/no or a single value — should be left plain.",
      "When the user shares a durable fact about themselves (preferences, names, ongoing projects, recurring tasks), remember it in your memory so future replies stay consistent.",
      "You can inspect, improve, and ship your own code. Use read_source/list_source to read your source; propose_change to open a pull request with a fix or improvement (it is verified by typecheck and tests in a sandbox before the PR opens); list_pull_requests to see your open proposals; and merge_pull_request to merge one of your own once it's ready (merging deploys it). When asked to fix or improve yourself, use these tools rather than claiming you cannot modify your own code.",
      "If you are unsure or lack information, say so plainly rather than guessing.",
    ].join(" ");
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

    return { system: `${ctx.system}\n\nCurrent time (UTC): ${new Date().toISOString()}.` };
  }

  // Turn (and its streamed reply) is done: release the queue so any deferred
  // out-of-band messages go out now, after the reply — never during it.
  async onChatResponse(_result: ChatResponseResult): Promise<void> {
    this.turnActive = false;
    const queued = this.outboundQueue;
    this.outboundQueue = [];
    for (const m of queued) await this.notifyUser(m.text, m.chatId);
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
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: { id: this.env.AI_GATEWAY_ID },
    });
    const { text } = await generateText({
      model: workersai(this.env.MODEL_ID, { reasoning_effort: null }),
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
    return defineMessengers({
      // richTelegramMessenger is a drop-in for Think's telegramMessenger that
      // delivers Bot API 10.1 Rich Messages on the streamed reply path (native
      // tables/headings/lists from the model's GFM). It degrades to MarkdownV2
      // automatically, and the `rich` flag is a kill switch (ENABLE_RICH_MESSAGES).
      telegram: richTelegramMessenger({
        rich: richMessagesEnabled(this.env),
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
        // and @mentions. For a personal 1:1 assistant that is what you want.
        //
        // To also handle group chats, uncomment the line below to react to
        // ordinary messages in subscribed threads and to button actions:
        //   respondTo: ["direct-message", "mention", "subscribed-thread", "action"],
        // Caveat: in groups, BotFather privacy mode (on by default) hides
        // non-command, non-mention messages from the bot. Either disable
        // privacy mode in BotFather (/setprivacy -> Disable) so the bot sees
        // all group messages, or rely on @mentions only.

        // conversation defaults to "thread": one Think sub-agent per Telegram
        // thread, so each chat keeps its own memory. Set conversation: "self"
        // to share a single memory across all chats instead.
        // conversation: "thread",
      }),
    });
  }
}
