# Contributing to tellboy

tellboy is a self-hostable Telegram-native personal assistant running on
Cloudflare Workers. Thanks for helping out!

## Prerequisites

- Node 22.18+
- `pnpm`
- A Cloudflare account with Workers AI available (only needed to run/deploy).

## Get the code

```sh
git clone https://github.com/MattieTK/tellboy.git
cd tellboy
pnpm install
```

## Running locally

Start the local Worker dev server:

```sh
pnpm dev          # wrangler dev
```

Workers AI calls hit Cloudflare even in local dev and may incur usage charges.

For local secrets (bot token, webhook secret), copy `.dev.vars.example` to
`.dev.vars` (gitignored) and fill it in instead of using `wrangler secret put`.

## Useful scripts

```sh
pnpm typecheck    # tsc --noEmit
pnpm cf-typegen   # regenerate worker-configuration.d.ts after wrangler.jsonc edits
pnpm test         # vitest run
pnpm register-webhook   # point Telegram at your Worker (see README)
pnpm deploy       # wrangler deploy
```

## Making a change

1. Create a branch from `master`.
2. Make your change, keeping it minimal and focused.
3. Run the gates that CI enforces:
   ```sh
   pnpm typecheck
   pnpm test
   ```
4. If you add or materially change a user-facing capability, update
   `FEATURES.md` in the same change (see `AGENTS.md`).
5. Open a pull request describing what changed and why.

See the `README.md` for the full setup (Telegram bot, Cloudflare secrets,
optional plugins) and `AGENTS.md` for project conventions.
