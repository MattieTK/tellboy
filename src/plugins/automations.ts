import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

/**
 * Payload carried from `create_automation`, through the durable schedule, to
 * `deliverAutomation()` (on TellboyAgent) when the alarm fires.
 *
 * An automation generalises a reminder: instead of a fixed message to echo
 * back, it carries an `instruction` the bot runs as a model turn when due, then
 * delivers the result proactively. So a one-off ("at 9am, summarise my open
 * PRs") or a recurring task ("every Monday, list this week's reminders") runs
 * the same way a live chat turn would, just unprompted.
 */
export interface AutomationPayload {
  /** What the bot should do when the automation fires, in the user's words. */
  instruction: string;
  /**
   * Telegram chat id captured when the automation was created. Carried in the
   * schedule payload so delivery doesn't depend on where the alarm fires or on
   * shared storage — the firing callback sends straight to this chat (mirrors
   * reminders; see AGENTS.md "capture everything at schedule time").
   */
  chatId?: string;
}

/**
 * Name of the agent method the scheduler calls when an automation is due.
 * `this.schedule()` resolves callbacks by method name (a string), so this
 * constant keeps the tool and the method (agent.ts) from drifting apart.
 */
export const AUTOMATION_CALLBACK = "deliverAutomation";

/**
 * Validate the three mutually-exclusive timing inputs and resolve them to a
 * single `when` the scheduler accepts (a delay in seconds, a cron string, or a
 * Date). Pure so it can be unit-tested without the agent or scheduler.
 *
 * Returns `{ when }` on success or `{ error }` with a human-readable reason —
 * the tool surfaces the error object to the model rather than throwing.
 */
export function resolveAutomationWhen(input: {
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
 * Natural-language automations — a generalisation of reminders. Where a
 * reminder echoes a fixed message, an automation runs a stored instruction as a
 * model turn when it fires and delivers the result proactively. Backed by the
 * same Agents SDK scheduler (`schedule`, `listSchedules`, `cancelSchedule`), so
 * no external dependency: enabled by default, disable with
 * `ENABLE_AUTOMATIONS=false`.
 */
export const automationsPlugin: Plugin = {
  name: "automations",

  isEnabled(env) {
    return envFlag(env, "automations") ?? true;
  },

  tools(agent: TellboyAgent): ToolSet {
    return {
      create_automation: tool({
        description:
          "Schedule an instruction the bot will carry out on its own at a " +
          "future time (a generalised reminder). When it fires, the bot runs " +
          "the instruction as a normal turn — using its tools — and delivers " +
          "the result to the user. Use this for tasks like 'every morning, " +
          "summarise my open PRs' or 'in two hours, check the logs and tell " +
          "me if anything broke'. Provide the time exactly one way: " +
          "`delaySeconds` for a relative delay, `at` for an absolute ISO 8601 " +
          "timestamp, or `cron` for a recurring schedule. The current time is " +
          "in the system context.",
        inputSchema: z.object({
          instruction: z
            .string()
            .min(1)
            .describe(
              "What the bot should do when the automation fires, in the " +
                "user's words (e.g. 'summarise my open pull requests').",
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
        execute: async ({ instruction, delaySeconds, at, cron }) => {
          const resolved = resolveAutomationWhen({ delaySeconds, at, cron });
          if ("error" in resolved) {
            return { error: resolved.error };
          }

          // Capture the chat id now, while the messenger context is live.
          const chatId = agent.getMessengerContext()?.thread.providerThreadId;
          const payload: AutomationPayload = { instruction, chatId };
          const schedule = await agent.schedule(
            resolved.when,
            AUTOMATION_CALLBACK,
            payload,
          );
          return {
            ok: true,
            id: schedule.id,
            // schedule.time is a Unix timestamp in seconds.
            scheduledFor: new Date(schedule.time * 1000).toISOString(),
          };
        },
      }),

      list_automations: tool({
        description: "List the user's pending automations.",
        inputSchema: z.object({}),
        execute: async () => {
          const all = await agent.listSchedules();
          const automations = all
            .filter((s) => s.callback === AUTOMATION_CALLBACK)
            .map((s) => ({
              id: s.id,
              instruction:
                (s.payload as AutomationPayload | undefined)?.instruction ?? "",
              scheduledFor: new Date(s.time * 1000).toISOString(),
              recurring: s.type === "cron" || s.type === "interval",
            }));
          return { automations };
        },
      }),

      cancel_automation: tool({
        description:
          "Cancel a pending automation by its id (as returned by " +
          "list_automations).",
        inputSchema: z.object({
          id: z.string().describe("The automation id to cancel."),
        }),
        execute: async ({ id }) => {
          const cancelled = await agent.cancelSchedule(id);
          return cancelled
            ? { ok: true, id }
            : { ok: false, error: "No automation with that id." };
        },
      }),
    };
  },
};
