import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  markdownToHtml,
  formatForTelegram,
} from "../src/format";

// These guard the proactive-delivery path: malformed HTML here would make
// Telegram reject the message (reminders/selfdev results silently fail).

describe("escapeHtml", () => {
  it("escapes the three HTML-special characters", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("escapes ampersand first (no double-escaping)", () => {
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("markdownToHtml", () => {
  it("converts inline styles to Telegram HTML tags", () => {
    expect(markdownToHtml("**bold**")).toBe("<b>bold</b>");
    expect(markdownToHtml("*italic*")).toBe("<i>italic</i>");
    expect(markdownToHtml("~~gone~~")).toBe("<s>gone</s>");
    expect(markdownToHtml("`code`")).toBe("<code>code</code>");
  });

  it("renders links", () => {
    expect(markdownToHtml("[label](https://x.test)")).toBe(
      '<a href="https://x.test">label</a>',
    );
  });

  it("escapes raw HTML in plain text so it can't break parsing", () => {
    expect(markdownToHtml("1 < 2 & 3 > 0")).toBe("1 &lt; 2 &amp; 3 &gt; 0");
  });

  it("renders fenced code as <pre><code> with escaped contents", () => {
    const out = markdownToHtml("```\nconst x = a < b && c;\n```");
    expect(out).toContain("<pre><code>");
    expect(out).toContain("a &lt; b &amp;&amp; c");
    expect(out).not.toContain("a < b");
  });

  it("does not re-parse markdown inside inline code", () => {
    expect(markdownToHtml("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  it("renders a markdown table as a <pre> block", () => {
    const out = markdownToHtml("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(out).toContain("<pre>");
  });

  it("renders headings as bold and blockquotes as <blockquote>", () => {
    expect(markdownToHtml("# Title")).toBe("<b>Title</b>");
    expect(markdownToHtml("> quoted")).toBe("<blockquote>quoted</blockquote>");
  });
});

describe("formatForTelegram", () => {
  it("returns HTML parse mode", () => {
    expect(formatForTelegram("hi").parseMode).toBe("HTML");
  });

  it("handles empty input without throwing", () => {
    expect(formatForTelegram("").text).toBe("");
  });
});
