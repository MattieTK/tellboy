/**
 * Rich-message delivery for the streamed reply path.
 *
 * tellboy's inbound replies are streamed by @cloudflare/think through the Chat
 * SDK's Telegram adapter, which only ever calls `sendMessage` / `sendMessageDraft`
 * (MarkdownV2). To deliver Bot API 10.1 Rich Messages on that path we subclass
 * the adapter and override the two send seams:
 *
 *   - `postMessage`  — the non-streamed send AND the finaliser the base `stream()`
 *                      calls (`this.postMessage(threadId, { markdown })`). Because
 *                      that finalise dispatches dynamically to this override, the
 *                      persisted streamed reply becomes a Rich Message even if we
 *                      never touched `stream()`.
 *   - `stream`       — adds a live, animated rich preview via `sendRichMessageDraft`
 *                      while the model is generating, then finalises via
 *                      `postMessage` (→ `sendRichMessage`).
 *
 * Everything degrades gracefully, honouring the project's "never wedge the bot"
 * rule (AGENTS.md): a rejected rich send falls back to `super.postMessage`
 * (MarkdownV2); a failed draft just disables the live preview; a non-rich-enabled
 * adapter defers to the base entirely. Each layer lands on a delivered message.
 *
 * We reuse the base adapter's own `telegramFetch` (its typed error handling and
 * rate-limiting) and a few of its internal helpers. Those internals are not in
 * the published types, so we reach them through a narrow typed view and keep the
 * whole rich path inside a try/catch → base-class fallback, so a future adapter
 * version that renames an internal degrades rather than breaks.
 */
import {
  TelegramAdapter,
  type TelegramAdapterConfig,
} from "@chat-adapter/telegram";
import { chatSdkMessenger } from "@cloudflare/think/messengers";
import telegramMessenger, {
  TELEGRAM_STREAM_SOFT_LIMIT,
  defaultTelegramThreadShard,
  isExpectedTelegramFinalEditNoop,
  shardTelegramStateKey,
  splitTelegramMessageText,
  telegramSecretTokenVerifier,
  type TelegramMessengerOptions,
} from "@cloudflare/think/messengers/telegram";
import { RICH_MESSAGE_CHAR_LIMIT, toInputRichMessage } from "./rich";

// Default cadence for draft updates, mirroring the base adapter's default.
const DRAFT_UPDATE_INTERVAL_MS = 250;

// The base adapter's instance members we rely on but that aren't in its public
// types. Accessed via `this.internals` so the coupling is explicit and typed.
interface TelegramAdapterInternals {
  telegramFetch(method: string, payload?: unknown): Promise<TelegramSentMessage>;
  resolveThreadId(threadId: string): { chatId: string; messageThreadId?: number };
  encodeThreadId(data: { chatId: string; messageThreadId?: number }): string;
  parseTelegramMessage(
    raw: TelegramSentMessage,
    threadId: string,
  ): { id: string; threadId: string };
  cacheMessage(message: unknown): void;
  logger?: { warn?(message: string, meta?: unknown): void };
}

// The shape of a Telegram Message we read back from sendRichMessage.
interface TelegramSentMessage {
  chat: { id: number | string };
  message_thread_id?: number;
}

type PostMessageArgs = Parameters<TelegramAdapter["postMessage"]>;
type PostMessageResult = ReturnType<TelegramAdapter["postMessage"]>;
type RawMessage = Awaited<PostMessageResult>;
type PostableMessage = PostMessageArgs[1];

export interface RichTelegramAdapterConfig extends TelegramAdapterConfig {
  /** When true, plain-text/markdown sends and streams use Bot API Rich Messages. */
  rich?: boolean;
}

export class RichTelegramAdapter extends TelegramAdapter {
  private readonly richEnabled: boolean;
  // Per-stream draft id; non-zero and reused within one stream so Telegram
  // animates successive updates (see sendRichMessageDraft.draft_id).
  private draftSeq = 0;

  constructor(config: RichTelegramAdapterConfig = {}) {
    super(config);
    this.richEnabled = config.rich ?? false;
  }

  private get internals(): TelegramAdapterInternals {
    return this as unknown as TelegramAdapterInternals;
  }

  override async postMessage(...args: PostMessageArgs): PostMessageResult {
    const [threadId, message] = args;
    const markdown = this.richEnabled ? plainMarkdownOf(message) : null;
    if (markdown === null || markdown.trim() === "") {
      return super.postMessage(...args);
    }
    try {
      return await this.sendRich(threadId, markdown);
    } catch (error) {
      // Any rejection (unsupported, bad body, renamed internal) → MarkdownV2.
      this.internals.logger?.warn?.(
        "tellboy: rich postMessage failed; falling back to sendMessage",
        String(error),
      );
      return super.postMessage(...args);
    }
  }

  override async stream(
    ...args: Parameters<TelegramAdapter["stream"]>
  ): ReturnType<TelegramAdapter["stream"]> {
    const [threadId, textStream, options] = args;
    // Not enabled, or a group/channel (rich drafts are private-chat only): let
    // the base stream. Its finaliser still routes through our postMessage
    // override, so the persisted reply is rich regardless.
    if (!this.richEnabled || !isDirectMessage(threadId)) {
      return super.stream(...args);
    }
    return this.streamRich(threadId, textStream, options);
  }

  // Send a Rich Message and mirror the base adapter's post-send bookkeeping
  // (thread id encoding + message cache) so downstream edit/recovery still work.
  private async sendRich(threadId: string, markdown: string): Promise<RawMessage> {
    // Over the rich body limit → throw so postMessage's catch falls back to the
    // base path, which truncates/splits, rather than eating a remote 400.
    if (markdown.length > RICH_MESSAGE_CHAR_LIMIT) {
      throw new Error(
        `rich message body exceeds ${RICH_MESSAGE_CHAR_LIMIT} chars`,
      );
    }
    const { chatId, messageThreadId } = this.internals.resolveThreadId(threadId);
    const raw = await this.internals.telegramFetch("sendRichMessage", {
      chat_id: chatId,
      message_thread_id: messageThreadId,
      rich_message: toInputRichMessage(markdown),
    });
    const resultingThreadId = this.internals.encodeThreadId({
      chatId: String(raw.chat.id),
      messageThreadId: raw.message_thread_id ?? messageThreadId,
    });
    const parsed = this.internals.parseTelegramMessage(raw, resultingThreadId);
    this.internals.cacheMessage(parsed);
    return { id: parsed.id, threadId: parsed.threadId, raw } as RawMessage;
  }

  private async streamRich(
    threadId: string,
    textStream: AsyncIterable<unknown>,
    options: Parameters<TelegramAdapter["stream"]>[2],
  ): ReturnType<TelegramAdapter["stream"]> {
    const { chatId, messageThreadId } = this.internals.resolveThreadId(threadId);
    const draftId = this.allocateDraftId();
    const intervalMs = Math.max(
      0,
      (options as { updateIntervalMs?: number } | undefined)?.updateIntervalMs ??
        DRAFT_UPDATE_INTERVAL_MS,
    );

    let accumulated = "";
    let lastSent: string | null = null;
    let lastFlushAt = 0;
    let draftsEnabled = true;

    const flushDraft = async (): Promise<void> => {
      if (
        !draftsEnabled ||
        accumulated === lastSent ||
        !accumulated.trim() ||
        accumulated.length > RICH_MESSAGE_CHAR_LIMIT
      ) {
        // Over-limit drafts would 400; skip them and let the final send fall
        // back. (chat_id is Integer-only for the draft method, so coerce.)
        return;
      }
      try {
        await this.internals.telegramFetch("sendRichMessageDraft", {
          chat_id: Number(chatId),
          message_thread_id: messageThreadId,
          draft_id: draftId,
          rich_message: toInputRichMessage(accumulated),
        });
        lastSent = accumulated;
        lastFlushAt = Date.now();
      } catch (error) {
        // Live preview is best-effort; the final send below is unaffected.
        draftsEnabled = false;
        this.internals.logger?.warn?.(
          "tellboy: rich draft update failed; final send unaffected",
          String(error),
        );
      }
    };

    for await (const chunk of textStream) {
      const text = textOfChunk(chunk);
      if (text === null) continue;
      accumulated += text;
      if (Date.now() - lastFlushAt >= intervalMs) {
        await flushDraft();
      }
    }
    await flushDraft();

    // Finalise through the overridden postMessage: a non-empty body becomes a
    // persisted Rich Message; an empty body falls to super.postMessage, which
    // throws the base adapter's "text cannot be empty" error as before.
    return this.postMessage(threadId, { markdown: accumulated } as PostableMessage);
  }

  private allocateDraftId(): number {
    this.draftSeq = this.draftSeq >= 2147483646 ? 1 : this.draftSeq + 1;
    return this.draftSeq;
  }
}

// Extract the raw model markdown from a postable, or null when the message is
// not plain text/markdown (cards, files, attachments, pre-escaped raw, or an
// already-parsed AST keep the base adapter's normal rendering path).
function plainMarkdownOf(message: PostableMessage): string | null {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const m = message as unknown as Record<string, unknown>;
    if (m.card || m.type === "card") return null;
    if (Array.isArray(m.files) && m.files.length > 0) return null;
    if (Array.isArray(m.attachments) && m.attachments.length > 0) return null;
    if (typeof m.markdown === "string") return m.markdown;
  }
  return null;
}

// A streamed chunk is either a raw string or a `{ type: "markdown_text", text }`
// event; anything else (tool events, etc.) contributes no visible text.
function textOfChunk(chunk: unknown): string | null {
  if (typeof chunk === "string") return chunk;
  if (chunk && typeof chunk === "object") {
    const c = chunk as { type?: string; text?: unknown };
    if (c.type === "markdown_text" && typeof c.text === "string") return c.text;
  }
  return null;
}

// Telegram encodes group/channel chat ids as negative numbers; a DM chat id
// does not start with "-". Mirrors the base adapter's isDM without coupling to it.
function isDirectMessage(threadId: string): boolean {
  const parts = threadId.split(":");
  const chatId = parts[0] === "telegram" ? parts[1] : parts[0];
  return chatId !== undefined && chatId !== "" && !chatId.startsWith("-");
}

export interface RichTelegramMessengerOptions extends TelegramMessengerOptions {
  /** Enable Bot API Rich Messages on this messenger's send + stream paths. */
  rich?: boolean;
}

/**
 * A drop-in replacement for Think's `telegramMessenger` that uses
 * {@link RichTelegramAdapter}. It replicates the upstream wiring (capabilities,
 * delivery policy, webhook verification, state sharding) faithfully — the only
 * difference is the adapter instance and the `rich` flag forwarded to it.
 */
export function richTelegramMessenger(
  options: RichTelegramMessengerOptions,
): ReturnType<typeof telegramMessenger> {
  const { rich, ...rest } = options;
  const adapterName = options.adapterName ?? "telegram";
  const shardThread =
    options.shardKey ??
    ((threadId: string) => defaultTelegramThreadShard(threadId, adapterName));

  if (
    (options.mode ?? "webhook") === "webhook" &&
    !options.secretToken &&
    options.verifyWebhook === undefined
  ) {
    throw new Error(
      "richTelegramMessenger requires secretToken for webhook verification, or verifyWebhook: false to opt out explicitly",
    );
  }

  const adapter = new RichTelegramAdapter({
    apiBaseUrl: options.apiBaseUrl,
    apiUrl: options.apiUrl,
    botToken: options.token,
    mode: options.mode ?? "webhook",
    secretToken: options.secretToken,
    userName: options.userName,
    rich: rich ?? false,
  });

  return chatSdkMessenger({
    ...rest,
    adapter,
    adapterName,
    capabilities: {
      canEditMessages: true,
      canStream: true,
      supportsActions: true,
      supportsAttachments: true,
      ...options.capabilities,
    },
    delivery: {
      isExpectedDeliveryCompletion: isExpectedTelegramFinalEditNoop,
      splitText: splitTelegramMessageText,
      visibleSoftLimit: TELEGRAM_STREAM_SOFT_LIMIT,
      ...options.delivery,
    },
    keyShard: (key: string) =>
      options.keyShard?.(key) ?? shardTelegramStateKey(key, shardThread),
    provider: "telegram",
    shardKey: shardThread,
    userName: options.userName,
    verifyWebhook:
      options.verifyWebhook === false
        ? false
        : (options.verifyWebhook ?? telegramSecretTokenVerifier(options.secretToken)),
  });
}
