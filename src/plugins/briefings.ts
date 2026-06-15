import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

/**
 * Daily proactive briefings. The user picks a local time (and optionally a
 * timezone) and the bot, unprompted, compiles and sends a morning-style brief
 * each day: reminders/automations due today plus any topics the user has asked
 * it to watch.
 *
 * It rides the same proven `agent.schedule(cron, callback, payload)` path as
 * reminders/automations (no Think getScheduledTasks): the local time is
 * converted to a UTC cron — the bot runs in UTC — and a recurring schedule
 * fires `deliverBriefing()` (on TellboyAgent), which runs a model turn and
 * delivers the result proactively. The chat id is captured at schedule time and
 * carried in the payload, so delivery never depends on where the alarm fires
 * (AGENTS.md "capture everything at schedule time").
 *
 * No external dependency, so enabled by default; disable with
 * `ENABLE_BRIEFINGS=false`.
 */

/**
 * Payload carried from `set_briefing`, through the durable schedule, to
 * `deliverBriefing()` (on TellboyAgent) when the daily alarm fires.
 */
export interface BriefingPayload {
  /** The user's requested local fire time, "HH:MM" (24h). Kept for display. */
  time: string;
  /** IANA timezone the time is expressed in (e.g. "Europe/London"). */
  timezone: string;
  /**
   * Telegram chat id captured when the briefing was set. Carried in the
   * schedule payload so delivery doesn't depend on where the alarm fires or on
   * shared storage — the firing callback sends straight to this chat.
   */
  chatId?: string;
}

/**
 * Name of the agent method the scheduler calls when a briefing is due.
 * `this.schedule()` resolves callbacks by method name (a string), so this
 * constant keeps the tool and the method (agent.ts) from drifting apart.
 */
export const BRIEFING_CALLBACK = "deliverBriefing";

/** Default timezone when the user doesn't name one. UTC is unambiguous. */
const DEFAULT_TIMEZONE = "UTC";

/**
 * Minutes a timezone is ahead of UTC at a given instant (e.g. +60 for
 * Europe/London in summer, -240 for America/New_York in summer, +330 for
 * Asia/Kolkata). Uses Intl — no dependency, no fixed offset table to maintain —
 * by formatting the instant in the target zone and diffing against UTC. Returns
 * `undefined` for an unknown timezone (Intl throws on a bad zone), so callers
 * can surface a clean error rather than letting it bubble up.
 *
 * Pure (modulo the `now` argument, which is passed in), so it is unit-testable.
 */
export function tzOffsetMinutes(timezone: string, now: Date): number | undefined {
  let parts: Intl.DateTimeFormatPart[];
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    parts = dtf.formatToParts(now);
  } catch {
    return undefined;
  }
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  // Some environments render midnight as "24"; normalise to 0.
  const hour = map.hour === "24" ? 0 : Number(map.hour);
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );
  return Math.round((asUTC - now.getTime()) / 60000);
}

/** Parse and validate an "HH:MM" 24-hour time. Returns minutes-since-midnight. */
function parseHhMm(time: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

/**
 * Convert a local "HH:MM" + IANA timezone into a daily UTC cron (`m h * * *`)
 * the scheduler can run, since the bot runs in UTC. The conversion subtracts the
 * zone's UTC offset (computed for `now`, half-hour zones included) from the
 * local minutes, wrapping across midnight so the cron always lands in 0..1439.
 *
 * DST caveat: a static cron can't track DST, so a briefing pinned to a wall
 * time will drift by an hour across a transition (e.g. "09:00 London" computed
 * in summer fires at 08:00 UTC, which is 09:00 BST but 08:00 GMT after the
 * autumn change). We accept that for a daily personal brief; re-running
 * `set_briefing` after a transition re-pins it. Computing the offset for `now`
 * keeps it correct at the time the user sets it.
 *
 * Returns `{ cron }` on success or `{ error }` with a human-readable reason.
 * Pure (modulo the injected `now`), so it is unit-testable.
 */
export function localTimeToUtcCron(
  time: string,
  timezone: string,
  now: Date,
): { cron: string; utcHour: number; utcMinute: number } | { error: string } {
  const localMinutes = parseHhMm(time);
  if (localMinutes === undefined) {
    return { error: `Could not parse time "${time}" — use 24-hour HH:MM.` };
  }
  const offset = tzOffsetMinutes(timezone, now);
  if (offset === undefined) {
    return { error: `Unknown timezone "${timezone}" — use an IANA name like "Europe/London".` };
  }
  // UTC = local - offset; wrap into a single day so the cron stays valid.
  const total = (((localMinutes - offset) % 1440) + 1440) % 1440;
  const utcHour = Math.floor(total / 60);
  const utcMinute = total % 60;
  return { cron: `${utcMinute} ${utcHour} * * *`, utcHour, utcMinute };
}

export const briefingsPlugin: Plugin = {
  name: "briefings",

  isEnabled(env) {
    return envFlag(env, "briefings") ?? true;
  },

  tools(agent: TellboyAgent): ToolSet {
    return {
      set_briefing: tool({
        description:
          "Set up a daily briefing the bot sends UNPROMPTED at a local time " +
          "each day — a morning-style brief of the day's reminders and " +
          "automations plus any topics the user follows. Provide `time` as a " +
          "24-hour HH:MM and, if you know it, the user's `timezone` as an IANA " +
          "name (e.g. 'Europe/London'); it defaults to UTC. Calling this again " +
          "replaces any existing briefing. Use disable_briefing to turn it off.",
        inputSchema: z.object({
          time: z
            .string()
            .describe("Local time to send the briefing, 24-hour HH:MM (e.g. '08:30')."),
          timezone: z
            .string()
            .optional()
            .describe(
              "IANA timezone the time is in (e.g. 'America/New_York'). " +
                "Defaults to UTC if omitted.",
            ),
        }),
        execute: async ({ time, timezone }) => {
          const tz = timezone?.trim() || DEFAULT_TIMEZONE;
          const resolved = localTimeToUtcCron(time, tz, new Date());
          if ("error" in resolved) {
            return { error: resolved.error };
          }

          // Capture the chat id now, while the messenger context is live.
          const chatId = agent.getMessengerContext()?.thread.providerThreadId;
          const payload: BriefingPayload = { time: time.trim(), timezone: tz, chatId };

          // Replace any existing briefing first so there's only ever one.
          const existing = await agent.listSchedules();
          for (const s of existing) {
            if (s.callback === BRIEFING_CALLBACK) {
              await agent.cancelSchedule(s.id);
            }
          }

          const schedule = await agent.schedule(
            resolved.cron,
            BRIEFING_CALLBACK,
            payload,
          );
          return {
            ok: true,
            id: schedule.id,
            time: payload.time,
            timezone: tz,
            // schedule.time is a Unix timestamp in seconds.
            nextRun: new Date(schedule.time * 1000).toISOString(),
          };
        },
      }),

      disable_briefing: tool({
        description:
          "Turn off the daily briefing, if one is set. Safe to call when none " +
          "is configured.",
        inputSchema: z.object({}),
        execute: async () => {
          const all = await agent.listSchedules();
          const briefings = all.filter((s) => s.callback === BRIEFING_CALLBACK);
          for (const s of briefings) {
            await agent.cancelSchedule(s.id);
          }
          return briefings.length > 0
            ? { ok: true, disabled: briefings.length }
            : { ok: true, disabled: 0, note: "No briefing was set." };
        },
      }),
    };
  },
};
