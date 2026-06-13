// tellboy-deployer: a deliberately tiny, separate Worker that is the ONLY
// thing allowed to deploy the tellboy Worker. It exists so the powerful deploy
// credential never sits in the same isolate as the LLM-driven bot.
//
// The bot holds only DEPLOY_SECRET (an opaque capability). It calls POST
// /deploy here; this Worker — a separate isolate with its own env the bot
// cannot read — triggers the tellboy repo's deploy workflow. Repo, workflow,
// and ref are hard-coded, so the caller cannot redirect the deploy anywhere
// else. The actual Cloudflare API token lives only in GitHub Actions.
//
// Worst case if the bot is fully compromised: an attacker can trigger a
// redeploy of tellboy from master. Nothing else.

interface Env {
  /** Shared capability secret; the bot sends this as a bearer token. */
  DEPLOY_SECRET: string;
  /** GitHub token with actions:write on MattieTK/tellboy ONLY (fine-grained PAT). */
  DEPLOYER_GH_TOKEN: string;
}

const REPO = "MattieTK/tellboy";
const WORKFLOW = "deploy.yml";
const REF = "master";

// Length-independent constant-time compare to avoid leaking the secret via
// response timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/deploy") {
      return new Response("Not found", { status: 404 });
    }

    const provided = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${env.DEPLOY_SECRET}`;
    if (!env.DEPLOY_SECRET || !timingSafeEqual(provided, expected)) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Hard-coded target: the caller has no say over repo / workflow / ref.
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.DEPLOYER_GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "tellboy-deployer",
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref: REF }),
      },
    );

    if (!res.ok) {
      return new Response(`deploy trigger failed: ${res.status}`, {
        status: 502,
      });
    }
    return new Response("deploy triggered", { status: 202 });
  },
};
