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
import {
  VOICE_DOWNLOAD_TIMEOUT_MS,
  buildTranscriptEcho,
  removeAudioAttachments,
  selectVoiceAttachment,
  shouldTranscribe,
  transcribeVoiceMessage,
  type TranscribeRunner,
  type VoiceAttachment,
} from "./voice";

// Default cadence for draft updates, mirroring the base adapter's default.
const DRAFT_UPDATE_INTERVAL_MS = 250;

// The base adapter's instance members we rely on but that aren't in its public
// types. Accessed via `this.internals` so the coupling is explicit and typed.
interface TelegramAdapterInternals {
  telegramFetch(
    method: string,
    payload?: unknown,
    request?: { signal?: AbortSignal },
  ): Promise<TelegramSentMessage & { file_path?: string }>;
  resolveThreadId(threadId: string): { chatId: string; messageThreadId?: number };
  encodeThreadId(data: { chatId: string; messageThreadId?: number }): string;
  parseTelegramMessage(
    raw: TelegramSentMessage,
    threadId: string,
  ): InboundMessage;
  cacheMessage(message: unknown): void;
  logger?: { warn?(message: string, meta?: unknown): void };
  // The mutable bits the voice path needs to read/replace on an inbound message,
  // plus the chat instance that schedules the turn. All present on the base
  // adapter; reached through this view so the coupling stays explicit and the
  // whole voice path try/catches into a graceful fallback if one is renamed.
  apiBaseUrl: string;
  botToken: string;
  formatConverter: { toAst(text: string): unknown };
  chat: {
    processMessage(
      adapter: unknown,
      threadId: string,
      message: InboundMessage | (() => Promise<InboundMessage>),
      options?: unknown,
    ): unknown;
  } | null;
}

// The inbound-message shape the voice path reads from / writes to. The base
// adapter returns a richer Chat SDK `Message`, but we only touch these fields.
interface InboundMessage {
  id: string;
  threadId: string;
  text: string;
  formatted: unknown;
  attachments?: VoiceAttachment[];
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
  /**
   * When set, inbound voice/audio messages are transcribed with this Workers AI
   * runner and the transcript becomes the turn's text. Passed from agent.ts
   * (where `env.AI` is reachable) rather than holding `env` here, which keeps
   * the adapter testable and free of the Worker `Env` type. Absent → voice
   * notes pass through untouched (the previous behaviour).
   */
  voice?: { run: TranscribeRunner };
}

export class RichTelegramAdapter extends TelegramAdapter {
  private readonly richEnabled: boolean;
  private readonly voiceRunner?: TranscribeRunner;
  // Per-stream draft id; non-zero and reused within one stream so Telegram
  // animates successive updates (see sendRichMessageDraft.draft_id).
  private draftSeq = 0;

  constructor(config: RichTelegramAdapterConfig = {}) {
    super(config);
    this.richEnabled = config.rich ?? false;
    this.voiceRunner = config.voice?.run;
  }

  private get internals(): TelegramAdapterInternals {
    return this as unknown as TelegramAdapterInternals;
  }

  // Inbound seam for voice notes. The base parses the update into a Message with
  // empty text and an `audio` attachment, then calls chat.processMessage. When
  // transcription is enabled and the message is a text-less voice/audio note, we
  // hand processMessage an async factory instead: it transcribes the audio,
  // makes the transcript the turn's text, and echoes it back so the user can
  // correct any mis-hearing. The factory runs inside processMessage's tracked
  // task (registered via options.waitUntil), so the webhook still returns 200
  // immediately and the turn never blocks on the download/transcribe.
  //
  // Anything unexpected (no chat, renamed internal, disabled) degrades to the
  // base behaviour — the voice note simply passes through as before.
  override handleIncomingMessageUpdate(
    ...args: Parameters<TelegramAdapter["handleIncomingMessageUpdate"]>
  ): void {
    const [telegramMessage, options] = args;
    if (!this.voiceRunner) return super.handleIncomingMessageUpdate(...args);

    let parsed: InboundMessage;
    let threadId: string;
    let chat: TelegramAdapterInternals["chat"];
    try {
      chat = this.internals.chat;
      if (!chat) return super.handleIncomingMessageUpdate(...args);
      threadId = this.internals.encodeThreadId({
        chatId: String(telegramMessage.chat.id),
        messageThreadId: telegramMessage.message_thread_id,
      });
      parsed = this.internals.parseTelegramMessage(
        telegramMessage as unknown as TelegramSentMessage,
        threadId,
      );
    } catch {
      // Reaching the internals failed (e.g. a renamed base member): fall back.
      return super.handleIncomingMessageUpdate(...args);
    }

    if (!shouldTranscribe(parsed.text, parsed.attachments)) {
      return super.handleIncomingMessageUpdate(...args);
    }

    // Voice note with no text: build the transcript inside the processMessage
    // task so the webhook response isn't held while we download + transcribe.
    const factory = async (): Promise<InboundMessage> => {
      await this.applyTranscript(parsed, threadId);
      this.internals.cacheMessage(parsed);
      return parsed;
    };
    chat.processMessage(this, threadId, factory, options);
  }

  // Transcribe the message's audio in place: set the transcript as the turn text
  // (so the model sees what was said) and echo it back to the chat. On any
  // failure the text becomes a short, plain note so the turn is never empty and
  // the user knows the note couldn't be understood. Never throws.
  private async applyTranscript(
    message: InboundMessage,
    threadId: string,
  ): Promise<void> {
    const attachment = selectVoiceAttachment(message.attachments);
    const transcript = attachment
      ? await transcribeVoiceMessage(attachment, {
          fetchAudio: (a) => this.downloadAudio(a),
          run: this.voiceRunner!,
        })
      : null;

    // Consume the audio: the transcript is now the turn's text, so drop the raw
    // audio attachment. Left on the message, the model also receives it and
    // replies that it "can't process audio files" on top of the transcript.
    message.attachments = removeAudioAttachments(message.attachments);

    if (transcript === null) {
      message.text =
        "(I received a voice note but couldn't transcribe it. Please ask me to try again, or type your message.)";
      this.setFormatted(message);
      await this.echo(
        threadId,
        "🎙️ Sorry, I couldn't transcribe that voice note. Could you try again or type it?",
      );
      return;
    }

    message.text = transcript;
    this.setFormatted(message);
    await this.echo(threadId, buildTranscriptEcho(transcript));
  }

  // Rebuild the message's formatted AST from its (now transcript) text, so the
  // downstream pipeline sees a consistent text/formatted pair. Best-effort: if
  // the converter is unreachable, leave the existing formatted value.
  private setFormatted(message: InboundMessage): void {
    try {
      message.formatted = this.internals.formatConverter.toAst(message.text);
    } catch {
      // Keep the original formatted value; text is what the model reads.
    }
  }

  // Download a voice/audio attachment's bytes, time-bounded per AGENTS.md: both
  // the getFile lookup and the file fetch carry an AbortSignal.timeout so a slow
  // Telegram response can't stall the inbound task. Resolves to the raw bytes.
  private async downloadAudio(
    attachment: VoiceAttachment & { fetchMetadata?: { fileId?: string } },
  ): Promise<ArrayBuffer> {
    const fileId = attachment.fetchMetadata?.fileId;
    if (!fileId) throw new Error("voice attachment has no fileId");
    const file = await this.internals.telegramFetch(
      "getFile",
      { file_id: fileId },
      { signal: AbortSignal.timeout(VOICE_DOWNLOAD_TIMEOUT_MS) },
    );
    if (!file.file_path) throw new Error("getFile returned no file_path");
    const url = `${this.internals.apiBaseUrl}/file/bot${this.internals.botToken}/${file.file_path}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(VOICE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`file download failed: ${res.status}`);
    return res.arrayBuffer();
  }

  // Echo a plain message back to the chat (the transcript or a failure note).
  // Best-effort: a failed echo must not break the turn the transcript feeds, so
  // we swallow errors — the model's reply still goes out on the normal path.
  private async echo(threadId: string, text: string): Promise<void> {
    try {
      const { chatId, messageThreadId } =
        this.internals.resolveThreadId(threadId);
      await this.internals.telegramFetch("sendMessage", {
        chat_id: chatId,
        message_thread_id: messageThreadId,
        text,
      });
    } catch (error) {
      this.internals.logger?.warn?.(
        "tellboy: voice transcript echo failed (turn unaffected)",
        String(error),
      );
    }
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
    // Positive confirmation in observability that a Rich Message went out (the
    // adapter only logs on failure otherwise, so success was previously
    // invisible). Cheap; remove once the feature is well-proven.
    console.log(
      "tellboy: rich message sent",
      JSON.stringify({ chars: markdown.length, hasTable: markdown.includes("|"), hasHeading: /^#{1,6}\s/m.test(markdown) }),
    );
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
  /**
   * Enable inbound voice-note transcription. The `run` function is the Workers
   * AI runner (typically `(model, input) => env.AI.run(model, input)`), passed
   * from agent.ts where `env.AI` is reachable. Omit to leave voice notes as-is.
   */
  voice?: { run: TranscribeRunner };
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
  const { rich, voice, ...rest } = options;
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
    voice,
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
