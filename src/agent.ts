import { Think, Session, type TurnContext, type TurnConfig } from "@cloudflare/think";
import { defineMessengers, ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
import telegramMessenger from "@cloudflare/think/messengers/telegram";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { createWorkersAI } from "workers-ai-provider";
import { generateText, type LanguageModel, type ToolSet } from "ai";
import { getSandbox } from "@cloudflare/sandbox";
import { collectTools } from "./plugins";
import type { ReminderPayload } from "./plugins/reminders";
import type { VerifiedChangePayload } from "./plugins/selfdev";
import { getDefaultBranch, openPullRequest, type GitHubConfig } from "./github";

// Cap noisy command output before it goes into a chat message.
function truncate(text: string, max = 1500): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n… (truncated)` : t;
}

// Single-quote a string for `sh -c` so titles with spaces/quotes are safe.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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

  getSystemPrompt(): string {
    // Fallback persona. Once the `memory` context block (below) accumulates
    // facts, those are layered on top of this prompt.
    return [
      "You are Tellboy, a personal assistant that talks to one person over Telegram.",
      "Be concise and direct. Prefer short answers; expand only when asked.",
      "Use plain text suitable for a chat window. Avoid heavy Markdown and long lists unless they genuinely help.",
      "When the user shares a durable fact about themselves (preferences, names, ongoing projects, recurring tasks), remember it in your memory so future replies stay consistent.",
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
    return { system: `${ctx.system}\n\nCurrent time (UTC): ${new Date().toISOString()}.` };
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
    await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            text:
              "(A reminder you scheduled is now due. Tell me about it " +
              "naturally; do not mention this instruction.) Reminder: " +
              payload.message,
          },
        ],
      },
    ]);
  }

  // Proactively relay an internal update to the user (same messenger path as
  // deliverReminder): inject a prompt, the reply is delivered to Telegram.
  private async notifyUser(text: string): Promise<void> {
    await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            text:
              "(Internal update — relay this to me naturally; do not mention " +
              "this instruction.) " +
              text,
          },
        ],
      },
    ]);
  }

  // Scheduler callback for the selfdev `propose_change` tool. Runs OFF the chat
  // turn (clone + install + typecheck is too slow to block a reply). Verifies
  // the proposed edit in a Sandbox container and only opens a PR if it passes
  // `pnpm typecheck`; the outcome is relayed to the user via notifyUser().
  //
  // PR-only by design — no merge — so a human review stays the gate.
  async runVerifiedChange(payload: VerifiedChangePayload): Promise<void> {
    const cfg: GitHubConfig = {
      token: this.env.GITHUB_TOKEN ?? "",
      repo: this.env.GITHUB_REPO ?? "",
    };
    if (!cfg.token || !cfg.repo) {
      await this.notifyUser("I couldn't verify that change — GitHub isn't configured.");
      return;
    }

    const sandbox = getSandbox(this.env.Sandbox, "selfdev-builder");
    const repoDir = "/workspace/repo";
    // Token-bearing remote so both clone and push authenticate. The sandbox is
    // isolated and ephemeral, so the credential never leaves the container.
    const authUrl = `https://x-access-token:${cfg.token}@github.com/${cfg.repo}.git`;

    try {
      const base = await getDefaultBranch(cfg);

      // Fresh checkout each run.
      await sandbox.exec(`rm -rf ${repoDir}`);
      await sandbox.gitCheckout(authUrl, {
        branch: base,
        targetDir: repoDir,
        depth: 1,
      });
      await sandbox.exec(`git remote set-url origin ${authUrl}`, { cwd: repoDir });
      await sandbox.exec(`git config user.email "bot@tellboy.local"`, { cwd: repoDir });
      await sandbox.exec(`git config user.name "tellboy-bot"`, { cwd: repoDir });

      // Apply the proposed files.
      for (const f of payload.files) {
        const full = `${repoDir}/${f.path}`;
        await sandbox.mkdir(full.slice(0, full.lastIndexOf("/")), {
          recursive: true,
        });
        await sandbox.writeFile(full, f.content);
      }

      // Install (warm pnpm store from the image keeps this fast) + typecheck.
      const install = await sandbox.exec("pnpm install --frozen-lockfile", {
        cwd: repoDir,
        timeout: 240_000,
      });
      if (!install.success) {
        await this.notifyUser(
          `I couldn't verify the change — \`pnpm install\` failed:\n${truncate(install.stderr || install.stdout)}`,
        );
        return;
      }
      const check = await sandbox.exec("pnpm typecheck", {
        cwd: repoDir,
        timeout: 180_000,
      });
      if (!check.success) {
        await this.notifyUser(
          `The change does NOT pass \`pnpm typecheck\`, so I did not open a PR. Errors:\n${truncate(`${check.stdout}\n${check.stderr}`)}`,
        );
        return;
      }

      // Commit + push a fresh branch.
      const branch = `bot/${crypto.randomUUID().slice(0, 8)}`;
      await sandbox.exec(`git checkout -b ${branch}`, { cwd: repoDir });
      await sandbox.exec("git add -A", { cwd: repoDir });
      const commit = await sandbox.exec(
        `git commit -m ${shellQuote(payload.title)}`,
        { cwd: repoDir },
      );
      if (!commit.success) {
        await this.notifyUser(
          "Nothing to commit — the proposed files match the current code.",
        );
        return;
      }
      const push = await sandbox.exec(`git push origin ${branch}`, {
        cwd: repoDir,
      });
      if (!push.success) {
        await this.notifyUser(
          `Verified, but the push failed:\n${truncate(push.stderr)}`,
        );
        return;
      }

      // Open the PR from here (Workers can't run git, but a REST call is fine).
      const pr = await openPullRequest(cfg, {
        title: payload.title,
        body: `${payload.body}\n\n---\n_Verified in a sandbox: \`pnpm typecheck\` passed._`,
        head: branch,
        base,
      });
      if ("error" in pr) {
        await this.notifyUser(
          `Verified and pushed \`${branch}\`, but opening the PR failed: ${pr.error}`,
        );
        return;
      }
      await this.notifyUser(
        `Verified (\`pnpm typecheck\` passed) and opened a PR for your review: ${pr.url}`,
      );
    } catch (err) {
      await this.notifyUser(
        `That change errored during verification: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  }

  getMessengers() {
    return defineMessengers({
      telegram: telegramMessenger({
        token: this.env.TELEGRAM_BOT_TOKEN,
        userName: this.env.TELEGRAM_BOT_USERNAME,
        // Verified back via the X-Telegram-Bot-Api-Secret-Token header on every
        // webhook delivery. telegramMessenger throws in webhook mode if this is
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
