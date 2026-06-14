/**
 * Telegram Bot API 10.1 "Rich Messages" — the outbound envelope.
 *
 * Rich Messages (added 2026-06-11) let a bot send document-grade content:
 * native headings, tables, ordered/unordered/task lists, blockquotes, dividers,
 * spoilers and more — the things the legacy `sendMessage` parse modes could not
 * express (Telegram HTML has no table or heading entity, so `format.ts` had to
 * degrade tables to an ASCII block inside `<pre>`).
 *
 * The key asymmetry of the API: to SEND, you do not build a structured block
 * tree. `InputRichMessage` carries the whole body as a single `markdown` or
 * `html` string (exactly one of the two), and Telegram parses it server-side
 * into its `RichBlock`/`RichText` representation. The structured tree only
 * appears on the RECEIVING side (`Message.rich_message`).
 *
 * We use the `markdown` field: Telegram's "Rich Markdown style" is GitHub
 * Flavored Markdown (plus arbitrary HTML), which is exactly what the model
 * already emits. So the model's raw reply passes straight through and renders
 * natively — no conversion step, and higher fidelity than the HTML path. The
 * `html` route (via `format.ts`) remains the fallback when a rich send is
 * rejected or disabled.
 *
 * Pure module: same input, same output, no I/O. Safe to call from any delivery
 * path, including scheduled-alarm callbacks.
 *
 * See https://core.telegram.org/bots/api#inputrichmessage
 */

/**
 * The object passed as `rich_message` to `sendRichMessage` /
 * `sendRichMessageDraft` / `editMessageText`. Exactly one of `html` / `markdown`
 * must be set.
 */
export interface InputRichMessage {
  /** Body as Telegram "Rich HTML style" markup. Mutually exclusive with `markdown`. */
  html?: string;
  /** Body as Telegram "Rich Markdown style" (GitHub Flavored Markdown). Mutually exclusive with `html`. */
  markdown?: string;
  /** Render the message right-to-left. */
  is_rtl?: boolean;
  /**
   * Skip automatic detection of bare URLs, emails, @mentions, hashtags, etc.
   * We leave it unset (detection on) so bare links the model mentions stay
   * clickable, while explicit `[label](url)` links are honoured either way.
   */
  skip_entity_detection?: boolean;
}

/**
 * Wrap the model's Markdown as an `InputRichMessage` for the rich send path.
 *
 * The text is passed through verbatim because Telegram's Rich Markdown is
 * GitHub Flavored Markdown — the dialect the model already produces. Empty or
 * nullish input round-trips to `{ markdown: "" }` rather than throwing; callers
 * are expected to skip sending empty bodies (Telegram rejects them).
 */
export function toInputRichMessage(markdown: string): InputRichMessage {
  return { markdown: markdown ?? "" };
}

/**
 * Telegram's rich message body limit (32768 UTF-8 characters). Used as a guard
 * so an over-long body fails fast into the fallback path rather than making a
 * doomed call that Telegram rejects with a 400. The base adapter applies its
 * own much smaller truncation on the legacy path, so falling back is safe.
 * https://core.telegram.org/bots/api#rich-message-limits
 */
export const RICH_MESSAGE_CHAR_LIMIT = 32_768;
