/**
 * Telegram-safe message formatting.
 *
 * This module converts the model's Markdown output into a string that Telegram
 * can parse with `parse_mode: "HTML"`. We prefer HTML over MarkdownV2 because
 * HTML has a much smaller escaping surface: only three characters (`&`, `<`,
 * `>`) ever need escaping, and they always escape the same way regardless of
 * context. MarkdownV2 by contrast requires escaping ~18 characters whose
 * meaning depends on whether they sit inside or outside an entity, which makes
 * round-tripping arbitrary model output fragile.
 *
 * Everything here is a pure function: same input, same output, no I/O, no
 * shared mutable state. That keeps the module trivially testable and safe to
 * call from any delivery path.
 *
 * Supported Telegram HTML entities (Bot API "HTML style"):
 *   <b>            bold
 *   <i>            italic
 *   <u>            underline
 *   <s>            strikethrough
 *   <tg-spoiler>   spoiler
 *   <a href="">    inline link
 *   <code>         inline fixed-width
 *   <pre>          block fixed-width
 *   <pre><code class="language-xxx"> fenced code with language hint
 *   <blockquote>   block quotation (add the `expandable` attribute to collapse)
 *
 * Escaping rules (see https://core.telegram.org/bots/api#html-style):
 *   - All `&`, `<`, `>` that are NOT part of a tag must be replaced with
 *     `&amp;`, `&lt;`, `&gt;` respectively.
 *   - Entities must not be nested inside <code> or <pre>; the textual content
 *     of those elements is still escaped, but no child tags are emitted.
 *
 * Note on Rich Messages (Bot API 10.1 `sendRichMessage` / `RichBlock*` /
 * `RichText*`): those are NOT used here. Our delivery stack
 * (@cloudflare/think -> @chat-adapter/telegram) only calls `sendMessage` /
 * `editMessageText`, and never `sendRichMessage`, so the structured
 * Rich Message API is unreachable today. Producing well-formed HTML is the
 * highest-fidelity option the current stack can deliver.
 */

/** Telegram parse mode values relevant to text delivery. */
export type TelegramParseMode = "HTML" | "MarkdownV2";

/** A converted message ready to hand to the Bot API. */
export interface FormattedTelegramMessage {
  /** The formatted body, escaped/marked-up for the chosen parse mode. */
  text: string;
  /** The parse mode the body was produced for. */
  parseMode: TelegramParseMode;
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

/**
 * Escape the three characters Telegram HTML mode treats as special.
 *
 * Order matters: `&` must be replaced first, otherwise the ampersands we
 * introduce for `<`/`>` would be double-escaped.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape a URL for use inside an `href` attribute. Telegram parses the same
 * three entities here, and a stray `"` would terminate the attribute, so we
 * also encode double quotes.
 */
function escapeHref(url: string): string {
  return escapeHtml(url).replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Inline span conversion
// ---------------------------------------------------------------------------

/**
 * Convert the inline Markdown found inside a single logical line (or other
 * already-escaped-free segment) into Telegram HTML.
 *
 * The function operates on RAW (un-escaped) text. It walks the string once,
 * emitting escaped literal runs and wrapping recognised spans in HTML tags.
 * Inline code is special-cased so its contents are escaped but never re-parsed
 * for further Markdown (Telegram forbids nested entities in <code>).
 *
 * Recognised spans (in priority order):
 *   `code`                 -> <code>code</code>
 *   [label](url)           -> <a href="url">label</a>
 *   **bold** / __bold__    -> <b>bold</b>
 *   *italic* / _italic_    -> <i>italic</i>
 *   ~~strike~~             -> <s>strike</s>
 *   ||spoiler||            -> <tg-spoiler>spoiler</tg-spoiler>
 *
 * Anything unrecognised is treated as literal text and HTML-escaped.
 */
export function inlineToHtml(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;

  // Accumulate literal characters here, flushing (escaped) when we hit a span.
  let literal = "";
  const flush = () => {
    if (literal) {
      out += escapeHtml(literal);
      literal = "";
    }
  };

  while (i < n) {
    const ch = input[i];

    // --- inline code: contents are escaped but not further parsed ---
    if (ch === "`") {
      // Support one or more backticks as the fence (e.g. ``a`b``).
      let fence = 0;
      while (input[i + fence] === "`") fence++;
      const open = "`".repeat(fence);
      const close = input.indexOf(open, i + fence);
      if (close !== -1) {
        flush();
        const code = input.slice(i + fence, close);
        // Trim a single surrounding space, matching CommonMark code-span rules.
        const trimmed =
          code.startsWith(" ") && code.endsWith(" ") && code.trim() !== ""
            ? code.slice(1, -1)
            : code;
        out += `<code>${escapeHtml(trimmed)}</code>`;
        i = close + fence;
        continue;
      }
    }

    // --- link: [label](url) ---
    if (ch === "[") {
      const link = matchLink(input, i);
      if (link) {
        flush();
        // The label may itself contain inline markup; the URL must not.
        out += `<a href="${escapeHref(link.url)}">${inlineToHtml(link.label)}</a>`;
        i = link.end;
        continue;
      }
    }

    // --- spoiler: ||text|| ---
    if (ch === "|" && input[i + 1] === "|") {
      const span = matchDelimited(input, i, "||");
      if (span) {
        flush();
        out += `<tg-spoiler>${inlineToHtml(span.content)}</tg-spoiler>`;
        i = span.end;
        continue;
      }
    }

    // --- strikethrough: ~~text~~ ---
    if (ch === "~" && input[i + 1] === "~") {
      const span = matchDelimited(input, i, "~~");
      if (span) {
        flush();
        out += `<s>${inlineToHtml(span.content)}</s>`;
        i = span.end;
        continue;
      }
    }

    // --- bold: **text** or __text__ ---
    if ((ch === "*" && input[i + 1] === "*") || (ch === "_" && input[i + 1] === "_")) {
      const delim = ch + ch;
      const span = matchDelimited(input, i, delim);
      if (span) {
        flush();
        out += `<b>${inlineToHtml(span.content)}</b>`;
        i = span.end;
        continue;
      }
    }

    // --- italic: *text* or _text_ (single delimiter) ---
    if (ch === "*" || ch === "_") {
      const span = matchDelimited(input, i, ch);
      if (span && span.content.trim() !== "") {
        flush();
        out += `<i>${inlineToHtml(span.content)}</i>`;
        i = span.end;
        continue;
      }
    }

    // --- literal character ---
    literal += ch;
    i++;
  }

  flush();
  return out;
}

/**
 * Match a `[label](url)` link starting at `start` (which must point at `[`).
 * Returns the label, url, and the index just past the closing `)`, or null if
 * the text at `start` is not a well-formed link.
 */
function matchLink(
  input: string,
  start: number,
): { label: string; url: string; end: number } | null {
  // Find the matching ] for the opening [ (no nested brackets supported).
  const labelEnd = input.indexOf("]", start + 1);
  if (labelEnd === -1 || input[labelEnd + 1] !== "(") return null;
  const urlEnd = input.indexOf(")", labelEnd + 2);
  if (urlEnd === -1) return null;
  const label = input.slice(start + 1, labelEnd);
  const url = input.slice(labelEnd + 2, urlEnd).trim();
  if (url === "") return null;
  return { label, url, end: urlEnd + 1 };
}

/**
 * Match a span delimited by the same token on both sides, e.g. `**bold**`.
 * `start` must point at the first character of the opening delimiter. Returns
 * the inner content and the index just past the closing delimiter, or null.
 *
 * The closing delimiter is the first occurrence of `delim` after the opening
 * one; empty spans are rejected so a lone `**` is left as literal text.
 */
function matchDelimited(
  input: string,
  start: number,
  delim: string,
): { content: string; end: number } | null {
  const contentStart = start + delim.length;
  const close = input.indexOf(delim, contentStart);
  if (close === -1 || close === contentStart) return null;
  return { content: input.slice(contentStart, close), end: close + delim.length };
}

// ---------------------------------------------------------------------------
// Block-level conversion
// ---------------------------------------------------------------------------

interface FenceState {
  /** The fence marker (``` or ~~~) that opened the current code block. */
  marker: string;
  /** Collected raw lines of the code block. */
  lines: string[];
  /** Optional language hint from the opening fence. */
  lang: string;
}

/** Detect a fenced-code-block delimiter line (``` or ~~~, optionally longer). */
function matchFence(line: string): { marker: string; lang: string } | null {
  const m = /^(\s*)(`{3,}|~{3,})\s*([^`]*)$/.exec(line);
  if (!m) return null;
  return { marker: m[2], lang: m[3].trim() };
}

/** A table row split into trimmed cells (pipes stripped). */
function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  // Split on unescaped pipes.
  return row.split("|").map((c) => c.trim());
}

/** Is this line a Markdown table delimiter, e.g. `| --- | :--: |`? */
function isTableDelimiter(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/**
 * Render a parsed table (header + body rows) as a monospace ASCII table wrapped
 * in <pre>. Telegram has no native table entity, so a fixed-width block is the
 * faithful fallback. Cell contents are HTML-escaped; inline markup inside cells
 * is intentionally dropped because <pre> cannot contain nested entities.
 */
function tableToHtml(rows: string[][]): string {
  const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const widths = new Array<number>(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c], (row[c] ?? "").length);
    }
  }
  const pad = (text: string, width: number) => text + " ".repeat(width - text.length);
  const lines = rows.map((row) =>
    Array.from({ length: colCount }, (_, c) => pad(row[c] ?? "", widths[c])).join("  "),
  );
  return `<pre>${escapeHtml(lines.join("\n"))}</pre>`;
}

/**
 * Convert a full Markdown document into Telegram HTML.
 *
 * Block handling:
 *   - fenced code blocks (``` / ~~~) -> <pre><code class="language-..">..</code></pre>
 *   - tables                          -> monospace <pre> block
 *   - blockquotes (> ..)              -> <blockquote>..</blockquote>
 *   - ATX headings (#..)              -> bold line
 *   - bullet / ordered list items     -> "• item" / "n. item" with inline markup
 *   - everything else                 -> paragraph lines with inline markup
 *
 * Inline markup inside non-code blocks is delegated to `inlineToHtml`, which
 * also performs the HTML escaping. Plain lines are escaped here directly.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  let fence: FenceState | null = null;
  // Buffer consecutive lines that look like table rows so we can detect the
  // delimiter row and render the whole block at once.
  let tableBuffer: string[] = [];

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    // A valid table is: header, delimiter, then >=0 body rows.
    if (tableBuffer.length >= 2 && isTableDelimiter(tableBuffer[1])) {
      const header = splitTableRow(tableBuffer[0]);
      const body = tableBuffer.slice(2).map(splitTableRow);
      out.push(tableToHtml([header, ...body]));
    } else {
      // Not actually a table; emit the buffered lines as ordinary text.
      for (const raw of tableBuffer) out.push(inlineToHtml(raw));
    }
    tableBuffer = [];
  };

  for (const line of lines) {
    // --- inside a fenced code block ---
    if (fence) {
      const close = matchFence(line);
      if (close && line.trim().startsWith(fence.marker)) {
        const body = escapeHtml(fence.lines.join("\n"));
        const cls = fence.lang ? ` class="language-${escapeHtml(fence.lang)}"` : "";
        out.push(`<pre><code${cls}>${body}</code></pre>`);
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    // --- opening a fenced code block ---
    const fenceOpen = matchFence(line);
    if (fenceOpen) {
      flushTable();
      fence = { marker: fenceOpen.marker, lang: fenceOpen.lang, lines: [] };
      continue;
    }

    // --- table rows: buffer lines that contain a pipe ---
    if (line.includes("|") && line.trim() !== "") {
      tableBuffer.push(line);
      continue;
    }
    // A non-table line ends any buffered table.
    flushTable();

    // --- blockquote ---
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      out.push(`<blockquote>${inlineToHtml(quote[1])}</blockquote>`);
      continue;
    }

    // --- ATX heading: render as bold ---
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inlineToHtml(heading[1].trim())}</b>`);
      continue;
    }

    // --- unordered list item ---
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]}• ${inlineToHtml(bullet[2])}`);
      continue;
    }

    // --- ordered list item ---
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      out.push(`${ordered[1]}${ordered[2]}. ${inlineToHtml(ordered[3])}`);
      continue;
    }

    // --- blank or ordinary paragraph line ---
    out.push(line.trim() === "" ? "" : inlineToHtml(line));
  }

  // Close any unterminated structures so we never emit invalid HTML.
  if (fence) {
    const body = escapeHtml(fence.lines.join("\n"));
    const cls = fence.lang ? ` class="language-${escapeHtml(fence.lang)}"` : "";
    out.push(`<pre><code${cls}>${body}</code></pre>`);
  }
  flushTable();

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Convert a model-produced Markdown string into a Telegram-ready HTML message.
 *
 * Returns both the formatted text and the parse mode it was produced for, so a
 * caller can hand them straight to the Bot API (or to a delivery hook that
 * accepts a parse mode). Empty / whitespace-only input round-trips to an empty
 * string rather than throwing.
 */
export function formatForTelegram(markdown: string): FormattedTelegramMessage {
  return { text: markdownToHtml(markdown ?? ""), parseMode: "HTML" };
}
