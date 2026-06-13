import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

/**
 * Payload carried from `set_reminder`, through the durable schedule, to
 * `deliverReminder()` (on TellboyAgent) when the alarm fires.
 */
export interface ReminderPayload {
  message: string;
}

/**
 * Name of the agent method the scheduler calls when a reminder is due.
 * `this.schedule()` resolves callbacks by method name (a string), so this
 * constant keeps the tool and the method (agent.ts) from drifting apart.
 */
export const REMINDER_CALLBACK = "deliverReminder";

/**
 * Reminders / alarms backed by the Agents SDK scheduler (`schedule`,
 * `listSchedules`, `cancelSchedule`). No external dependency, so enabled by
 * default; disable with `ENABLE_REMINDERS=false`.
 */
export const remindersPlugin: Plugin = {
  name: "reminders",

  isEnabled(env) {
    return envFlag(env, "reminders") ?? true;
  },

  tools(agent: TellboyAgent): ToolSet {
    return {
      set_reminder: tool({
        description:
          "Schedule a reminder the bot will deliver to the user at a future " +
          "time. Provide the time exactly one way: `delaySeconds` for a " +
          "relative delay, `at` for an absolute ISO 8601 timestamp, or `cron` " +
          "for a recurring schedule. The current time is in the system context.",
        inputSchema: z.object({
          message: z
            .string()
            .min(1)
            .describe("What to remind the user about, in their words."),
          delaySeconds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Fire once, this many seconds from now."),
          at: z
            .string()
            .optional()
            .describe("Fire once at this absolute ISO 8601 timestamp."),
          cron: z
            .string()
            .optional()
            .describe("Recurring schedule as a cron expression."),
        }),
        execute: async ({ message, delaySeconds, at, cron }) => {
          // The three timing inputs are mutually exclusive — schedule() takes
          // one `when`, and mixing them is ambiguous.
          const provided = [delaySeconds, at, cron].filter(
            (v) => v !== undefined,
          );
          if (provided.length !== 1) {
            return { error: "Specify exactly one of delaySeconds, at, or cron." };
          }

          let when: Date | string | number;
          if (delaySeconds !== undefined) {
            when = delaySeconds;
          } else if (cron !== undefined) {
            when = cron;
          } else {
            const date = new Date(at!);
            if (Number.isNaN(date.getTime())) {
              return { error: `Could not parse timestamp: ${at}` };
            }
            when = date;
          }

          const payload: ReminderPayload = { message };
          const schedule = await agent.schedule(when, REMINDER_CALLBACK, payload);
          return {
            ok: true,
            id: schedule.id,
            // schedule.time is a Unix timestamp in seconds.
            scheduledFor: new Date(schedule.time * 1000).toISOString(),
          };
        },
      }),

      list_reminders: tool({
        description: "List the user's pending reminders.",
        inputSchema: z.object({}),
        execute: async () => {
          const all = await agent.listSchedules();
          const reminders = all
            .filter((s) => s.callback === REMINDER_CALLBACK)
            .map((s) => ({
              id: s.id,
              message: (s.payload as ReminderPayload | undefined)?.message ?? "",
              scheduledFor: new Date(s.time * 1000).toISOString(),
              recurring: s.type === "cron" || s.type === "interval",
            }));
          return { reminders };
        },
      }),

      cancel_reminder: tool({
        description:
          "Cancel a pending reminder by its id (as returned by list_reminders).",
        inputSchema: z.object({
          id: z.string().describe("The reminder id to cancel."),
        }),
        execute: async ({ id }) => {
          const cancelled = await agent.cancelSchedule(id);
          return cancelled
            ? { ok: true, id }
            : { ok: false, error: "No reminder with that id." };
        },
      }),
    };
  },
};
