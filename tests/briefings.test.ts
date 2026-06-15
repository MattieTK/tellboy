import { describe, it, expect } from "vitest";
import {
  tzOffsetMinutes,
  localTimeToUtcCron,
} from "../src/plugins/briefings";

// Guards the local-time + timezone -> UTC-cron conversion that schedules the
// daily briefing. The bot runs in UTC, so a wrong offset would fire the brief
// at the wrong hour (or silently never, on an unparseable cron).
//
// A fixed instant in mid-June pins the offsets in their summer (DST) state so
// the expectations don't drift with the real clock: London BST (+60), New York
// EDT (-240), Los Angeles PDT (-420), Tokyo (+540, no DST), Kolkata (+330).
const SUMMER = new Date("2026-06-15T12:00:00Z");
// A winter instant for the same zones to exercise the DST-aware offset.
const WINTER = new Date("2026-01-15T12:00:00Z");

describe("tzOffsetMinutes", () => {
  it("returns 0 for UTC", () => {
    expect(tzOffsetMinutes("UTC", SUMMER)).toBe(0);
  });

  it("reads positive offsets ahead of UTC", () => {
    expect(tzOffsetMinutes("Europe/London", SUMMER)).toBe(60);
    expect(tzOffsetMinutes("Asia/Tokyo", SUMMER)).toBe(540);
  });

  it("reads negative offsets behind UTC", () => {
    expect(tzOffsetMinutes("America/New_York", SUMMER)).toBe(-240);
    expect(tzOffsetMinutes("America/Los_Angeles", SUMMER)).toBe(-420);
  });

  it("handles half-hour offsets", () => {
    expect(tzOffsetMinutes("Asia/Kolkata", SUMMER)).toBe(330);
  });

  it("tracks DST: London is +0 in winter, +60 in summer", () => {
    expect(tzOffsetMinutes("Europe/London", WINTER)).toBe(0);
    expect(tzOffsetMinutes("Europe/London", SUMMER)).toBe(60);
  });

  it("returns undefined for an unknown timezone", () => {
    expect(tzOffsetMinutes("Not/AZone", SUMMER)).toBeUndefined();
  });
});

describe("localTimeToUtcCron", () => {
  it("subtracts the offset for a zone ahead of UTC", () => {
    // London 09:00 BST -> 08:00 UTC.
    const r = localTimeToUtcCron("09:00", "Europe/London", SUMMER);
    expect(r).toEqual({ cron: "0 8 * * *", utcHour: 8, utcMinute: 0 });
  });

  it("adds back the offset for a zone behind UTC", () => {
    // New York 09:00 EDT -> 13:00 UTC.
    const r = localTimeToUtcCron("09:00", "America/New_York", SUMMER);
    expect(r).toEqual({ cron: "0 13 * * *", utcHour: 13, utcMinute: 0 });
  });

  it("preserves the minute for half-hour zones", () => {
    // Kolkata 09:00 IST (+5:30) -> 03:30 UTC.
    const r = localTimeToUtcCron("09:00", "Asia/Kolkata", SUMMER);
    expect(r).toEqual({ cron: "30 3 * * *", utcHour: 3, utcMinute: 30 });
  });

  it("wraps backwards across midnight (local morning behind UTC date)", () => {
    // Tokyo 07:00 JST (+9) -> 22:00 UTC the previous day.
    const r = localTimeToUtcCron("07:00", "Asia/Tokyo", SUMMER);
    expect(r).toEqual({ cron: "0 22 * * *", utcHour: 22, utcMinute: 0 });
  });

  it("wraps forwards across midnight (local night ahead into next UTC day)", () => {
    // Los Angeles 23:00 PDT (-7) -> 06:00 UTC next day.
    const r = localTimeToUtcCron("23:00", "America/Los_Angeles", SUMMER);
    expect(r).toEqual({ cron: "0 6 * * *", utcHour: 6, utcMinute: 0 });
  });

  it("is a pass-through for UTC", () => {
    expect(localTimeToUtcCron("00:30", "UTC", SUMMER)).toEqual({
      cron: "30 0 * * *",
      utcHour: 0,
      utcMinute: 30,
    });
  });

  it("accepts single-digit hours", () => {
    expect(localTimeToUtcCron("7:05", "UTC", SUMMER)).toEqual({
      cron: "5 7 * * *",
      utcHour: 7,
      utcMinute: 5,
    });
  });

  it("rejects a malformed time", () => {
    expect(localTimeToUtcCron("9am", "UTC", SUMMER)).toEqual({
      error: expect.stringContaining("Could not parse"),
    });
    expect(localTimeToUtcCron("25:00", "UTC", SUMMER)).toEqual({
      error: expect.stringContaining("Could not parse"),
    });
    expect(localTimeToUtcCron("09:60", "UTC", SUMMER)).toEqual({
      error: expect.stringContaining("Could not parse"),
    });
  });

  it("rejects an unknown timezone", () => {
    expect(localTimeToUtcCron("09:00", "Not/AZone", SUMMER)).toEqual({
      error: expect.stringContaining("Unknown timezone"),
    });
  });
});
