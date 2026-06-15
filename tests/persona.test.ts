import { describe, it, expect } from "vitest";
import {
  composePersona,
  normalisePersona,
  DEFAULT_PERSONA,
  PERSONA_MAX_CHARS,
} from "../src/plugins/persona";

// Guards the persona-composition helpers that feed getSystemPrompt(). A
// regression here would change the assistant's voice on every turn, or let an
// oversized persona bloat the prompt.

describe("composePersona", () => {
  it("uses the conservative default when no persona is set", () => {
    const out = composePersona(undefined);
    expect(out).toContain(DEFAULT_PERSONA);
  });

  it("treats empty / whitespace / null as unset (default voice)", () => {
    for (const v of ["", "   ", "\n\t", null]) {
      expect(composePersona(v)).toContain(DEFAULT_PERSONA);
    }
  });

  it("injects a user-set persona verbatim (trimmed)", () => {
    const out = composePersona("  warm and playful  ");
    expect(out).toContain("warm and playful");
    expect(out).not.toContain("  warm and playful  ");
    expect(out).not.toContain(DEFAULT_PERSONA);
  });

  it("instructs the model that tone never overrides instructions or accuracy", () => {
    const out = composePersona("terse");
    expect(out).toContain("never let it override");
  });
});

describe("normalisePersona", () => {
  it("trims surrounding whitespace", () => {
    expect(normalisePersona("  formal  ")).toBe("formal");
  });

  it("returns undefined for an empty / whitespace input (reset to default)", () => {
    expect(normalisePersona("")).toBeUndefined();
    expect(normalisePersona("   \n ")).toBeUndefined();
  });

  it("clamps an over-long persona to the cap", () => {
    const long = "a".repeat(PERSONA_MAX_CHARS + 50);
    const out = normalisePersona(long);
    expect(out).toHaveLength(PERSONA_MAX_CHARS);
  });

  it("leaves a within-cap persona unchanged", () => {
    expect(normalisePersona("dry and technical")).toBe("dry and technical");
  });
});
