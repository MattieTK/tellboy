/**
 * Inbound voice-note understanding.
 *
 * When a Telegram voice note (or an audio clip) arrives, the message has no
 * text — only an `audio` attachment — so the model would otherwise see an empty
 * turn. This module downloads the audio (time-bounded), transcribes it with a
 * Workers AI Whisper model on the existing `env.AI` binding (no new credential),
 * and turns the transcript into the turn's user text. The transcript is also
 * echoed back to the chat so the user can spot and correct mis-hearings.
 *
 * The wiring lives in `rich-adapter.ts` (the inbound seam). This file keeps the
 * decision logic pure and testable: the attachment/MIME selection and the
 * echo-prefix builder are pure functions, and {@link transcribeVoiceMessage}
 * takes its side effects (audio fetch + AI run) as injected dependencies, so it
 * can be exercised in plain Node tests without `cloudflare:workers`.
 */

/**
 * Minimal structural view of the Chat SDK's `Attachment` (the type the Telegram
 * adapter produces from a voice/audio message). Declared locally rather than
 * imported from the transitive `chat` package, so this module has no dependency
 * coupling and stays usable from plain-Node tests. Only the fields the voice
 * path reads are listed.
 */
export interface VoiceAttachment {
  /** Attachment kind. Telegram maps both voice notes and audio clips to "audio". */
  type: "image" | "file" | "video" | "audio";
  /** MIME type, e.g. "audio/ogg" for a Telegram voice note. */
  mimeType?: string;
  /** Original filename, present for audio clips (not voice notes). */
  name?: string;
}

/**
 * Workers AI model used for transcription. whisper-large-v3-turbo accepts the
 * audio as a base64 string and auto-detects the language, which suits short
 * Telegram voice notes. Swap this constant to trade accuracy for latency/cost.
 */
export const VOICE_TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";

/**
 * Upper bound on the audio download. A voice note is small, but an unbounded
 * fetch that hangs would stall the inbound task (AGENTS.md: every outbound
 * fetch in a turn-adjacent path must have a timeout). Telegram caps Bot-API
 * file downloads at 20 MB, so this is comfortably long enough for real audio.
 */
export const VOICE_DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * The attachment types Telegram surfaces for spoken audio. A voice note is
 * mapped to `audio` by the adapter (see extractAttachments); a music/audio clip
 * is also `audio`. We transcribe both, and ignore everything else.
 */
const TRANSCRIBABLE_TYPES: ReadonlySet<VoiceAttachment["type"]> = new Set([
  "audio",
]);

/**
 * Pick the attachment to transcribe from an inbound message's attachments, or
 * `null` when there is nothing transcribable. Returns the first audio
 * attachment — a Telegram message carries at most one voice/audio part, so
 * first-match is sufficient and keeps the choice deterministic.
 */
export function selectVoiceAttachment<T extends VoiceAttachment>(
  attachments: readonly T[] | undefined,
): T | null {
  if (!attachments) return null;
  for (const a of attachments) {
    if (TRANSCRIBABLE_TYPES.has(a.type)) return a;
  }
  return null;
}

/**
 * Drop the audio attachments once they have been transcribed into text. This is
 * essential, not cosmetic: if the raw audio attachment is left on the message,
 * the model ALSO receives it and replies that it "can't process audio files" on
 * top of the transcribed answer. Returns a new array with any non-audio
 * attachments preserved.
 */
export function removeAudioAttachments<T extends VoiceAttachment>(
  attachments: readonly T[] | undefined,
): T[] {
  if (!attachments) return [];
  return attachments.filter((a) => !TRANSCRIBABLE_TYPES.has(a.type));
}

/**
 * Whether a message should be routed through transcription: it has a
 * transcribable audio attachment AND no usable text of its own. A voice note
 * with a caption (text) is left as-is — the user already typed what they meant.
 */
export function shouldTranscribe(
  text: string | undefined,
  attachments: readonly VoiceAttachment[] | undefined,
): boolean {
  if (text !== undefined && text.trim() !== "") return false;
  return selectVoiceAttachment(attachments) !== null;
}

/**
 * Build the message echoed back to the user after a successful transcription, so
 * they can see what the bot heard and correct it if Whisper misheard. Kept
 * short and quoted; an empty transcript yields a clear "couldn't make it out"
 * note rather than an empty echo.
 */
export function buildTranscriptEcho(transcript: string): string {
  const t = transcript.trim();
  if (t === "") {
    return "🎙️ I couldn't make out anything in that voice note.";
  }
  return `🎙️ I heard:\n\n> ${t}`;
}

/**
 * Encode raw audio bytes as a base64 string, the input shape Whisper-large-v3
 * expects on the `audio` field. Uses `Buffer` (available under nodejs_compat);
 * accepts an ArrayBuffer or any ArrayBufferView so callers can pass whatever the
 * download yields.
 */
export function audioToBase64(
  bytes: ArrayBuffer | ArrayBufferView | Buffer,
): string {
  if (Buffer.isBuffer(bytes)) return bytes.toString("base64");
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes).toString("base64");
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("base64");
}

/** Minimal view of the Whisper output we read (the model returns more). */
interface WhisperOutput {
  text?: unknown;
}

/**
 * The Workers AI runner, narrowed to what transcription needs. Injected rather
 * than reaching for `env.AI` directly so {@link transcribeVoiceMessage} stays
 * unit-testable in plain Node.
 */
export type TranscribeRunner = (
  model: string,
  input: { audio: string },
) => Promise<WhisperOutput | undefined>;

/** Download the audio bytes for the selected attachment. */
export type AudioFetcher<T extends VoiceAttachment = VoiceAttachment> = (
  attachment: T,
) => Promise<ArrayBuffer | ArrayBufferView | Buffer>;

/**
 * Run the audio through Whisper and return the trimmed transcript, or `null` on
 * any failure (download error, empty/garbled output). Never throws: the caller
 * runs inside the inbound task, where a throw would drop the user's turn — a
 * clean `null` lets it fall back to a "couldn't transcribe" reply instead.
 */
export async function transcribeVoiceMessage<T extends VoiceAttachment>(
  attachment: T,
  deps: { fetchAudio: AudioFetcher<T>; run: TranscribeRunner },
  model: string = VOICE_TRANSCRIBE_MODEL,
): Promise<string | null> {
  try {
    const bytes = await deps.fetchAudio(attachment);
    const audio = audioToBase64(bytes);
    if (audio === "") return null;
    const out = await deps.run(model, { audio });
    const text = typeof out?.text === "string" ? out.text.trim() : "";
    return text === "" ? null : text;
  } catch {
    // Swallow: the inbound path turns a null into a graceful fallback reply.
    return null;
  }
}
