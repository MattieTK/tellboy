import { Buffer } from "node:buffer";

// Minimal GitHub REST client shared by the selfdev plugin (reads) and the
// agent's sandbox-verified PR flow (open PR). Workers can't run `git`, so the
// read side and the PR-open side go through the REST API; the heavy git work
// (clone/commit/push) happens inside the Sandbox container instead.

const GITHUB_API = "https://api.github.com";

export interface GitHubConfig {
  token: string;
  repo: string; // "owner/name"
}

// GitHub requires a User-Agent header or returns 403.
export async function ghFetch(
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

export async function ghError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return `GitHub API ${res.status}: ${(JSON.parse(text) as { message?: string }).message ?? text}`;
  } catch {
    return `GitHub API ${res.status}: ${text}`;
  }
}

export async function getDefaultBranch(cfg: GitHubConfig): Promise<string> {
  const res = await ghFetch(cfg, "GET", `/repos/${cfg.repo}`);
  if (!res.ok) throw new Error(await ghError(res));
  return ((await res.json()) as { default_branch: string }).default_branch;
}

// Encode a repo path for a URL while keeping the slashes between segments.
function encodePath(path: string): string {
  return encodeURIComponent(path).replace(/%2F/g, "/");
}

export async function readSourceFile(
  cfg: GitHubConfig,
  path: string,
): Promise<
  | { content: string }
  | { error: string; entries?: Array<{ name: string; type: string }> }
> {
  const res = await ghFetch(
    cfg,
    "GET",
    `/repos/${cfg.repo}/contents/${encodePath(path)}`,
  );
  if (res.status === 404) return { error: `Not found: ${path}` };
  if (!res.ok) return { error: await ghError(res) };
  const data = (await res.json()) as
    | { type: "file"; content: string }
    | Array<{ name: string; type: string }>;
  if (Array.isArray(data)) {
    return {
      error: `${path} is a directory.`,
      entries: data.map((e) => ({ name: e.name, type: e.type })),
    };
  }
  return { content: Buffer.from(data.content, "base64").toString("utf-8") };
}

export async function listSourceFiles(
  cfg: GitHubConfig,
  prefix?: string,
): Promise<{ files: string[]; truncated?: boolean } | { error: string }> {
  const branch = await getDefaultBranch(cfg);
  // The recursive git tree lists every tracked file in one call; gitignored
  // files (e.g. .dev.vars) never appear.
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
  let files = tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
  if (prefix) files = files.filter((p) => p.startsWith(prefix));
  return { files, truncated: tree.truncated || undefined };
}

// Open a PR from an existing branch (created/pushed elsewhere, e.g. a sandbox).
export async function openPullRequest(
  cfg: GitHubConfig,
  args: { title: string; body: string; head: string; base: string },
): Promise<{ url: string; number: number } | { error: string }> {
  const res = await ghFetch(cfg, "POST", `/repos/${cfg.repo}/pulls`, args);
  if (!res.ok) return { error: await ghError(res) };
  const pr = (await res.json()) as { html_url: string; number: number };
  return { url: pr.html_url, number: pr.number };
}
