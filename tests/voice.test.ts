import { describe, it, expect } from "vitest";
import {
  audioToBase64,
  buildTranscriptEcho,
  removeAudioAttachments,
  selectVoiceAttachment,
  shouldTranscribe,
  transcribeVoiceMessage,
  VOICE_TRANSCRIBE_MODEL,
  type VoiceAttachment,
} from "../src/voice";

// These guard the inbound voice path's pure logic: which attachment we pick,
// whether a message routes to transcription, the echo the user sees, and the
// transcribe orchestration (with injected I/O, so no network/AI binding here).

const voice: VoiceAttachment = { type: "audio", mimeType: "audio/ogg" };
const image: VoiceAttachment = { type: "image", mimeType: "image/jpeg" };

describe("selectVoiceAttachment", () => {
  it("returns the first audio attachment", () => {
    expect(selectVoiceAttachment([image, voice])).toBe(voice);
  });

  it("returns null when there is no audio attachment", () => {
    expect(selectVoiceAttachment([image])).toBeNull();
  });

  it("returns null for empty or missing attachments", () => {
    expect(selectVoiceAttachment([])).toBeNull();
    expect(selectVoiceAttachment(undefined)).toBeNull();
  });
});

describe("removeAudioAttachments", () => {
  it("drops audio attachments so the model never sees the raw audio", () => {
    expect(removeAudioAttachments([image, voice])).toEqual([image]);
  });

  it("returns an empty array when everything was audio", () => {
    expect(removeAudioAttachments([voice])).toEqual([]);
  });

  it("handles empty or missing attachments", () => {
    expect(removeAudioAttachments([])).toEqual([]);
    expect(removeAudioAttachments(undefined)).toEqual([]);
  });
});

describe("shouldTranscribe", () => {
  it("transcribes a text-less voice note", () => {
    expect(shouldTranscribe("", [voice])).toBe(true);
    expect(shouldTranscribe(undefined, [voice])).toBe(true);
    expect(shouldTranscribe("   ", [voice])).toBe(true);
  });

  it("leaves a captioned voice note alone (user already typed)", () => {
    expect(shouldTranscribe("here is my note", [voice])).toBe(false);
  });

  it("does not transcribe non-audio or text-only messages", () => {
    expect(shouldTranscribe("", [image])).toBe(false);
    expect(shouldTranscribe("hello", [])).toBe(false);
    expect(shouldTranscribe("", [])).toBe(false);
  });
});

describe("buildTranscriptEcho", () => {
  it("quotes the transcript so the user can correct it", () => {
    expect(buildTranscriptEcho("buy milk")).toBe("🎙️ I heard:\n\n> buy milk");
  });

  it("trims surrounding whitespace", () => {
    expect(buildTranscriptEcho("  buy milk  ")).toBe(
      "🎙️ I heard:\n\n> buy milk",
    );
  });

  it("returns a clear note for an empty transcript", () => {
    expect(buildTranscriptEcho("")).toBe(
      "🎙️ I couldn't make out anything in that voice note.",
    );
    expect(buildTranscriptEcho("   ")).toBe(
      "🎙️ I couldn't make out anything in that voice note.",
    );
  });
});

describe("audioToBase64", () => {
  it("encodes a Buffer", () => {
    expect(audioToBase64(Buffer.from("hi"))).toBe(
      Buffer.from("hi").toString("base64"),
    );
  });

  it("encodes an ArrayBuffer", () => {
    const buf = new Uint8Array([104, 105]).buffer; // "hi"
    expect(audioToBase64(buf)).toBe(Buffer.from("hi").toString("base64"));
  });

  it("encodes an ArrayBufferView honouring its byte offset", () => {
    const full = new Uint8Array([0, 104, 105, 0]); // padded "hi"
    const view = full.subarray(1, 3);
    expect(audioToBase64(view)).toBe(Buffer.from("hi").toString("base64"));
  });
});

describe("transcribeVoiceMessage", () => {
  it("downloads, encodes, runs the model, and returns the trimmed transcript", async () => {
    const calls: Array<{ model: string; audio: string }> = [];
    const transcript = await transcribeVoiceMessage(voice, {
      fetchAudio: async () => Buffer.from("audio-bytes"),
      run: async (model, input) => {
        calls.push({ model, audio: input.audio });
        return { text: "  buy milk  " };
      },
    });
    expect(transcript).toBe("buy milk");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(VOICE_TRANSCRIBE_MODEL);
    expect(calls[0].audio).toBe(Buffer.from("audio-bytes").toString("base64"));
  });

  it("returns null when the model yields empty/whitespace text", async () => {
    const transcript = await transcribeVoiceMessage(voice, {
      fetchAudio: async () => Buffer.from("x"),
      run: async () => ({ text: "   " }),
    });
    expect(transcript).toBeNull();
  });

  it("returns null when the model returns no usable text field", async () => {
    const transcript = await transcribeVoiceMessage(voice, {
      fetchAudio: async () => Buffer.from("x"),
      run: async () => ({}),
    });
    expect(transcript).toBeNull();
  });

  it("returns null (never throws) when the download fails", async () => {
    const transcript = await transcribeVoiceMessage(voice, {
      fetchAudio: async () => {
        throw new Error("network down");
      },
      run: async () => ({ text: "should not reach" }),
    });
    expect(transcript).toBeNull();
  });

  it("returns null (never throws) when the model run fails", async () => {
    const transcript = await transcribeVoiceMessage(voice, {
      fetchAudio: async () => Buffer.from("x"),
      run: async () => {
        throw new Error("AI error");
      },
    });
    expect(transcript).toBeNull();
  });
});
