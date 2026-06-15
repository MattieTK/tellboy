import { describe, it, expect } from "vitest";
import { resolveAutomationWhen } from "../src/plugins/automations";

// Guards the create_automation timing validation: the three inputs are
// mutually exclusive and resolve to a single scheduler `when`. A regression
// here would schedule (or refuse) automations for the wrong time.

describe("resolveAutomationWhen", () => {
  it("passes a relative delay through as a number", () => {
    expect(resolveAutomationWhen({ delaySeconds: 60 })).toEqual({ when: 60 });
  });

  it("passes a cron expression through as a string", () => {
    expect(resolveAutomationWhen({ cron: "0 9 * * *" })).toEqual({
      when: "0 9 * * *",
    });
  });

  it("parses an absolute ISO timestamp into a Date", () => {
    const result = resolveAutomationWhen({ at: "2026-06-15T09:00:00.000Z" });
    expect("when" in result).toBe(true);
    if ("when" in result) {
      expect(result.when).toBeInstanceOf(Date);
      expect((result.when as Date).toISOString()).toBe(
        "2026-06-15T09:00:00.000Z",
      );
    }
  });

  it("rejects an unparseable timestamp", () => {
    expect(resolveAutomationWhen({ at: "not a date" })).toEqual({
      error: "Could not parse timestamp: not a date",
    });
  });

  it("requires exactly one timing input — none is an error", () => {
    expect(resolveAutomationWhen({})).toEqual({
      error: "Specify exactly one of delaySeconds, at, or cron.",
    });
  });

  it("requires exactly one timing input — more than one is an error", () => {
    expect(
      resolveAutomationWhen({ delaySeconds: 60, cron: "0 9 * * *" }),
    ).toEqual({ error: "Specify exactly one of delaySeconds, at, or cron." });
    expect(
      resolveAutomationWhen({ delaySeconds: 60, at: "2026-06-15T09:00:00Z" }),
    ).toEqual({ error: "Specify exactly one of delaySeconds, at, or cron." });
  });
});
