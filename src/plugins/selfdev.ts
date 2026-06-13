import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { envFlag, type Plugin } from "./types";
import { readSourceFile, listSourceFiles, type GitHubConfig } from "../github";
import type { TellboyAgent } from "../agent";

// Self-development: lets the bot read its own source and propose changes to
// itself. Reads go straight through the GitHub REST API (cheap). Changes are
// not opened blindly — `propose_change` hands the edit to a Sandbox container
// that clones the repo, applies the files, and runs `pnpm typecheck` before a
// PR is opened (see TellboyAgent.runVerifiedChange). A human still reviews and
// merges the PR: that is the safety gate on self-modification.
//
// Enabled when GITHUB_TOKEN and GITHUB_REPO ("owner/name") are both set;
// force on/off with ENABLE_SELFDEV.

export interface VerifiedChangePayload {
  title: string;
  body: string;
  files: Array<{ path: string; content: string }>;
}

// Method on TellboyAgent that the scheduler invokes to run the verification +
// PR. Kept as a constant so the tool and the method can't drift apart.
export const VERIFY_CALLBACK = "runVerifiedChange";

export const selfdevPlugin: Plugin = {
  name: "selfdev",

  isEnabled(env) {
    return (
      envFlag(env, "selfdev") ?? Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO)
    );
  },

  tools(agent: TellboyAgent, env: Env): ToolSet {
    const cfg: GitHubConfig = {
      token: env.GITHUB_TOKEN ?? "",
      repo: env.GITHUB_REPO ?? "",
    };

    return {
      list_source: tool({
        description:
          "List the bot's own source files (tracked files in its GitHub " +
          "repository). Use to discover what to read before proposing a change.",
        inputSchema: z.object({
          path: z
            .string()
            .optional()
            .describe("Optional path prefix to filter by, e.g. 'src/plugins'."),
        }),
        execute: async ({ path }) => {
          try {
            return await listSourceFiles(cfg, path);
          } catch (err) {
            return { error: String(err instanceof Error ? err.message : err) };
          }
        },
      }),

      read_source: tool({
        description:
          "Read one of the bot's own source files from its GitHub repository. " +
          "Returns the file's current contents on the default branch.",
        inputSchema: z.object({
          path: z
            .string()
            .min(1)
            .describe("Repo-relative file path, e.g. 'src/agent.ts'."),
        }),
        execute: async ({ path }) => {
          try {
            return await readSourceFile(cfg, path);
          } catch (err) {
            return { error: String(err instanceof Error ? err.message : err) };
          }
        },
      }),

      propose_change: tool({
        description:
          "Propose a change to the bot's own code. The change is verified in a " +
          "sandbox (clone + pnpm typecheck) and, if it passes, opened as a pull " +
          "request for human review — it is NOT merged. Verification runs in " +
          "the background; you will get a follow-up message with the PR link or " +
          "the type errors. Provide the FULL new contents for each file.",
        inputSchema: z.object({
          title: z
            .string()
            .min(1)
            .describe("PR title (conventional-commit style)."),
          body: z.string().describe("PR description: what changed and why."),
          files: z
            .array(
              z.object({
                path: z.string().min(1).describe("Repo-relative file path."),
                content: z
                  .string()
                  .describe("Full new file contents (replaces the file)."),
              }),
            )
            .min(1)
            .describe("Files to create or overwrite."),
        }),
        execute: async ({ title, body, files }) => {
          // The bot must not be able to weaken its own deploy machinery via a
          // PR. These paths hold the CI workflow and the deploy proxy; changes
          // to them go through humans only, not the self-edit flow.
          const PROTECTED = [".github/", "deployer/"];
          const blocked = files
            .map((f) => f.path)
            .filter((p) => PROTECTED.some((prefix) => p.startsWith(prefix)));
          if (blocked.length > 0) {
            return {
              error: `These paths are protected and cannot be changed by the bot: ${blocked.join(", ")}`,
            };
          }

          const payload: VerifiedChangePayload = { title, body, files };
          // Run off the chat turn: clone + install + typecheck is too slow to
          // block a reply. The scheduler fires (~immediately) on the same DO,
          // and the result is delivered proactively. delaySeconds 1 keeps it
          // off the current turn without a noticeable wait.
          await agent.schedule(1, VERIFY_CALLBACK, payload);
          return {
            ok: true,
            status:
              "queued for sandbox verification — will follow up with the PR " +
              "link or the type errors",
            files: files.map((f) => f.path),
          };
        },
      }),
    };
  },
};
