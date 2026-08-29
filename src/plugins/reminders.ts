import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";
import { AUTOMATION_CALLBACK, type AutomationPayload } from "./automations";

/**
 * Who acts when a scheduled reminder fires. Every reminder has a target:
 *
 *   - `"user"`  — the bot just delivers the fixed `message` to the user (a
 *                 plain nudge). Delivered via `deliverReminder`.
 *   - `"agent"` — the bot runs `instruction` as a model turn with its full
 *                 toolset, then delivers the constructed result to the user (a
 *                 generalised reminder / automation). Delivered via
 *                 `deliverAutomation`.
 *
 * This is the single unifying concept behind reminders and automations: a
 * reminder carries a message *and* declares who acts on it.
 */
export type ReminderTarget = "user" | "agent";

/**
 * Payload carried from `set_reminder` (target "user"), through the durable
 * schedule, to `deliverReminder()` (on TellboyAgent) when the alarm fires.
 */
export interface ReminderPayload {
  message: string;
  /**
   * Telegram chat id captured when the reminder was set. Carried in the
   * schedule payload so delivery doesn't depend on where the alarm fires or on
   * shared storage — the firing callback sends straight to this chat.
   */
  chatId?: string;
}

/**
 * Name of the agent method the scheduler calls when a user-target reminder is
 * due. `this.schedule()` resolves callbacks by method name (a string), so this
 * constant keeps the tool and the method (agent.ts) from drifting apart.
 */
export const REMINDER_CALLBACK = "deliverReminder";

/**
 * Validate the three mutually-exclusive timing inputs and resolve them to a
 * single `when` the scheduler accepts (a delay in seconds, a cron string, or a
 * Date). Pure so it can be unit-tested without the agent or scheduler.
 *
 * Returns `{ when }` on success or `{ error }` with a human-readable reason —
 * the tool surfaces the error object to the model rather than throwing.
 */
export function resolveReminderWhen(input: {
  delaySeconds?: number;
  at?: string;
  cron?: string;
}): { when: Date | string | number } | { error: string } {
  const { delaySeconds, at, cron } = input;
  // The three timing inputs are mutually exclusive — schedule() takes one
  // `when`, and mixing them is ambiguous.
  const provided = [delaySeconds, at, cron].filter((v) => v !== undefined);
  if (provided.length !== 1) {
    return { error: "Specify exactly one of delaySeconds, at, or cron." };
  }

  if (delaySeconds !== undefined) {
    return { when: delaySeconds };
  }
  if (cron !== undefined) {
    return { when: cron };
  }
  const date = new Date(at!);
  if (Number.isNaN(date.getTime())) {
    return { error: `Could not parse timestamp: ${at}` };
  }
  return { when: date };
}

/**
 * Reminders / alarms backed by the Agents SDK scheduler (`schedule`,
 * `listSchedules`, `cancelSchedule`). No external dependency, so enabled by
 * default; disable with `ENABLE_REMINDERS=false`.
 *
 * `set_reminder` is the unified entry point for the whole scheduling family: a
 * reminder has a `target` ("user" or "agent") that decides whether it's a
 * plain nudge or a bot-run automation. `create_automation` (automations.ts)
 * remains as the dedicated agent-target tool.
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
          "time. Every reminder has a target: `target: 'user'` (the default) " +
          "delivers a plain `message` nudge to the user; `target: 'agent'` " +
          "runs `instruction` as a bot turn with its tools and delivers the " +
          "constructed result to the user (a generalised reminder / " +
          "automation). Provide the time exactly one way: `delaySeconds` for a " +
          "relative delay, `at` for an absolute ISO 8601 timestamp, or `cron` " +
          "for a recurring schedule. The current time is in the system context.",
        inputSchema: z.object({
          target: z
            .enum(["user", "agent"])
            .optional()
            .describe(
              "Who acts when this fires: 'user' (default) delivers `message` to the user as a plain nudge; 'agent' runs `instruction` as a bot turn with its tools and sends the result.",
            ),
          message: z
            .string()
            .min(1)
            .describe("What to remind the user about, in their words."),
          instruction: z
            .string()
            .optional()
            .describe(
              "What the bot should do when this fires, required when target is 'agent'.",
            ),
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
        execute: async ({ message, target, instruction, delaySeconds, at, cron }) => {
          const resolved = resolveReminderWhen({ delaySeconds, at, cron });
          if ("error" in resolved) {
            return { error: resolved.error };
          }

          // Capture the chat id now, while the messenger context is live.
          const chatId = agent.getMessengerContext()?.thread.providerThreadId;

          // Agent-target: run the instruction as a bot turn when it fires,
          // exactly like create_automation. Route to the automation callback.
          if (target === "agent") {
            const trimmed = instruction?.trim();
            if (!trimmed) {
              return {
                error:
                  "An agent-target reminder needs an `instruction` for the bot to run.",
              };
            }
            const payload: AutomationPayload = { instruction: trimmed, chatId };
            const schedule = await agent.schedule(
              resolved.when,
              AUTOMATION_CALLBACK,
              payload,
            );
            return {
              ok: true,
              id: schedule.id,
              target: "agent",
              // schedule.time is a Unix timestamp in seconds.
              scheduledFor: new Date(schedule.time * 1000).toISOString(),
            };
          }

          // User-target (default): echo the fixed message as a plain nudge.
          const payload: ReminderPayload = { message, chatId };
          const schedule = await agent.schedule(
            resolved.when,
            REMINDER_CALLBACK,
            payload,
          );
          return {
            ok: true,
            id: schedule.id,
            target: "user",
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
              target: "user",
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
