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

export interface PullRequestInfo {
  number: number;
  title: string;
  head: string; // branch ref
  state: string;
  url: string;
}

export async function listPullRequests(
  cfg: GitHubConfig,
): Promise<PullRequestInfo[]> {
  const res = await ghFetch(
    cfg,
    "GET",
    `/repos/${cfg.repo}/pulls?state=open&per_page=50`,
  );
  if (!res.ok) throw new Error(await ghError(res));
  const arr = (await res.json()) as Array<{
    number: number;
    title: string;
    head: { ref: string };
    state: string;
    html_url: string;
  }>;
  return arr.map((p) => ({
    number: p.number,
    title: p.title,
    head: p.head.ref,
    state: p.state,
    url: p.html_url,
  }));
}

export async function getPullRequest(
  cfg: GitHubConfig,
  number: number,
): Promise<PullRequestInfo> {
  const res = await ghFetch(cfg, "GET", `/repos/${cfg.repo}/pulls/${number}`);
  if (!res.ok) throw new Error(await ghError(res));
  const p = (await res.json()) as {
    number: number;
    title: string;
    head: { ref: string };
    state: string;
    html_url: string;
  };
  return {
    number: p.number,
    title: p.title,
    head: p.head.ref,
    state: p.state,
    url: p.html_url,
  };
}

export async function mergePullRequest(
  cfg: GitHubConfig,
  number: number,
  method: "merge" | "squash" | "rebase" = "squash",
): Promise<{ merged: boolean; message?: string }> {
  const res = await ghFetch(
    cfg,
    "PUT",
    `/repos/${cfg.repo}/pulls/${number}/merge`,
    { merge_method: method },
  );
  const data = (await res.json()) as { merged?: boolean; message?: string };
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${data.message ?? "merge failed"}`);
  }
  return { merged: Boolean(data.merged), message: data.message };
}

export async function closePullRequest(
  cfg: GitHubConfig,
  number: number,
): Promise<void> {
  const res = await ghFetch(cfg, "PATCH", `/repos/${cfg.repo}/pulls/${number}`, {
    state: "closed",
  });
  if (!res.ok) throw new Error(await ghError(res));
}

// Delete a branch ref (used to tidy up after a merge/close).
export async function deleteBranch(
  cfg: GitHubConfig,
  branch: string,
): Promise<void> {
  // Best-effort: ignore failures (e.g. branch already gone).
  await ghFetch(cfg, "DELETE", `/repos/${cfg.repo}/git/refs/heads/${branch}`);
}
