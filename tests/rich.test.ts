import { describe, it, expect } from "vitest";
import { RICH_MESSAGE_CHAR_LIMIT, toInputRichMessage } from "../src/rich";

// Guards the rich-delivery envelope. A malformed InputRichMessage would make
// Telegram reject sendRichMessage and force every reply down the fallback path
// (or, on the alarm-driven proactive path, silently fail).

describe("toInputRichMessage", () => {
  it("passes the model's markdown through verbatim (Rich Markdown is GFM)", () => {
    const md = "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- two";
    expect(toInputRichMessage(md)).toEqual({ markdown: md });
  });

  it("sets the markdown field, never the html field", () => {
    const result = toInputRichMessage("**hi**");
    expect(result.markdown).toBe("**hi**");
    expect(result.html).toBeUndefined();
  });

  it("leaves entity detection on so bare links stay clickable", () => {
    expect(
      toInputRichMessage("see https://x.test").skip_entity_detection,
    ).toBeUndefined();
  });

  it("round-trips empty/nullish input to an empty body without throwing", () => {
    expect(toInputRichMessage("")).toEqual({ markdown: "" });
    expect(toInputRichMessage(undefined as unknown as string)).toEqual({
      markdown: "",
    });
  });
});

describe("RICH_MESSAGE_CHAR_LIMIT", () => {
  it("matches Telegram's documented 32768-character rich body limit", () => {
    expect(RICH_MESSAGE_CHAR_LIMIT).toBe(32_768);
  });
});
