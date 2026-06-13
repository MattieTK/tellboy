import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Buffer } from "node:buffer";
import { envFlag, type Plugin } from "./types";
import type { TellboyAgent } from "../agent";

// Self-development: lets the bot read its own source and open pull requests
// against its own repository, so it can propose fixes and improvements.
//
// Deliberately PR-only — there is no merge tool. A human reviews and merges,
// which is the safety gate on a self-modifying agent. Everything goes through
// the GitHub REST API because Workers cannot shell out to `git`.
//
// Enabled when GITHUB_TOKEN and GITHUB_REPO ("owner/name") are both set;
// force on/off with ENABLE_SELFDEV.

const GITHUB_API = "https://api.github.com";

interface GitHubConfig {
  token: string;
  repo: string; // "owner/name"
}

// One place for the headers GitHub requires (notably a User-Agent, without
// which the API returns 403).
async function ghFetch(
  cfg: GitHubConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tellboy-bot",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ghError(res: Response): Promise<string> {
  const text = await res.text();
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    // non-JSON body; use raw text
  }
  return `GitHub API ${res.status}: ${message}`;
}

async function getDefaultBranch(cfg: GitHubConfig): Promise<string> {
  const res = await ghFetch(cfg, "GET", `/repos/${cfg.repo}`);
  if (!res.ok) throw new Error(await ghError(res));
  return ((await res.json()) as { default_branch: string }).default_branch;
}

export const selfdevPlugin: Plugin = {
  name: "selfdev",

  isEnabled(env) {
    return (
      envFlag(env, "selfdev") ??
      Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO)
    );
  },

  tools(_agent: TellboyAgent, env: Env): ToolSet {
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
            const branch = await getDefaultBranch(cfg);
            // Recursive git tree gives every tracked file in one call
            // (gitignored files like .dev.vars never appear here).
            const res = await ghFetch(
              cfg,
              "GET",
              `/repos/${cfg.repo}/git/trees/${branch}?recursive=1`,
            );
            if (!res.ok) return { error: await ghError(res) };
            const tree = (await res.json()) as {
              tree: Array<{ path: string; type: string }>;
              truncated: boolean;
            };
            let files = tree.tree
              .filter((e) => e.type === "blob")
              .map((e) => e.path);
            if (path) files = files.filter((p) => p.startsWith(path));
            return {
              files,
              truncated: tree.truncated || undefined,
            };
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
            const res = await ghFetch(
              cfg,
              "GET",
              `/repos/${cfg.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
            );
            if (res.status === 404) return { error: `Not found: ${path}` };
            if (!res.ok) return { error: await ghError(res) };
            const data = (await res.json()) as
              | { type: "file"; content: string; encoding: string }
              | Array<{ name: string; type: string }>;
            if (Array.isArray(data)) {
              return {
                error: `${path} is a directory.`,
                entries: data.map((e) => ({ name: e.name, type: e.type })),
              };
            }
            const content = Buffer.from(data.content, "base64").toString("utf-8");
            return { path, content };
          } catch (err) {
            return { error: String(err instanceof Error ? err.message : err) };
          }
        },
      }),

      open_pull_request: tool({
        description:
          "Open a pull request against the bot's own repository with one or " +
          "more file changes. Creates a new branch, commits the files, and " +
          "opens the PR for human review. Does NOT merge. Use this to propose " +
          "fixes or improvements to the bot's own code.",
        inputSchema: z.object({
          title: z.string().min(1).describe("PR title (conventional-commit style)."),
          body: z
            .string()
            .describe("PR description: what changed and why."),
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
            .describe("Files to create or overwrite in the PR."),
        }),
        execute: async ({ title, body, files }) => {
          try {
            const base = await getDefaultBranch(cfg);

            // Resolve the base branch's head commit to branch from.
            const refRes = await ghFetch(
              cfg,
              "GET",
              `/repos/${cfg.repo}/git/ref/heads/${base}`,
            );
            if (!refRes.ok) return { error: await ghError(refRes) };
            const baseSha = (
              (await refRes.json()) as { object: { sha: string } }
            ).object.sha;

            // Unique branch name. crypto.randomUUID is available in Workers.
            const branch = `bot/${crypto.randomUUID().slice(0, 8)}`;
            const createRef = await ghFetch(
              cfg,
              "POST",
              `/repos/${cfg.repo}/git/refs`,
              { ref: `refs/heads/${branch}`, sha: baseSha },
            );
            if (!createRef.ok) return { error: await ghError(createRef) };

            // Commit each file onto the new branch via the contents API. An
            // existing file needs its blob sha to be overwritten.
            for (const file of files) {
              const apiPath = `/repos/${cfg.repo}/contents/${encodeURIComponent(file.path).replace(/%2F/g, "/")}`;
              const existing = await ghFetch(
                cfg,
                "GET",
                `${apiPath}?ref=${branch}`,
              );
              const sha = existing.ok
                ? ((await existing.json()) as { sha: string }).sha
                : undefined;
              const put = await ghFetch(cfg, "PUT", apiPath, {
                message: `${title}\n\n(file: ${file.path})`,
                content: Buffer.from(file.content, "utf-8").toString("base64"),
                branch,
                ...(sha ? { sha } : {}),
              });
              if (!put.ok) {
                return {
                  error: `Failed writing ${file.path}: ${await ghError(put)}`,
                  branch,
                };
              }
            }

            const prRes = await ghFetch(cfg, "POST", `/repos/${cfg.repo}/pulls`, {
              title,
              body,
              head: branch,
              base,
            });
            if (!prRes.ok) return { error: await ghError(prRes), branch };
            const pr = (await prRes.json()) as {
              html_url: string;
              number: number;
            };
            return { ok: true, url: pr.html_url, number: pr.number, branch };
          } catch (err) {
            return { error: String(err instanceof Error ? err.message : err) };
          }
        },
      }),
    };
  },
};
