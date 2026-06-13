# Sandbox image for the selfdev plugin's verification step. Must match the
# installed @cloudflare/sandbox version (0.12.1).
FROM docker.io/cloudflare/sandbox:0.12.1

# git: clone/commit/push the repo inside the sandbox.
# pnpm: install deps + run `pnpm typecheck` (pinned to the repo's major).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10

# Warm pnpm's content-addressable store from the lockfile so the runtime
# `pnpm install` mostly hard-links instead of downloading. Copying only the
# manifest + lockfile keeps this layer cached across source-only changes.
WORKDIR /warm
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch || true

WORKDIR /workspace
