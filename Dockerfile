# Pinned to node:22-bookworm, the tag .nvmrc and the sibling service images
# already declare. `node:latest` floats: a rebuild silently moves the runtime
# off the declared Node 22, so the image and the repo's pin drift apart with
# no signal anywhere.
FROM node:22-bookworm

RUN mkdir /XChainHub/
COPY ./package.json /XChainHub/package.json
COPY ./package-lock.json /XChainHub/package-lock.json
WORKDIR /XChainHub
RUN npm ci --omit=dev

# The llm attestation provider's default transport spawns this CLI by name
# (src/lib/claude-spawn.js: CLAUDE_BIN, default `claude`), which
# resolveHubLlmAuth PREFERS over an API key whenever HUB_CLAUDE_CONFIG_DIR is
# set. It has to live in the image, and it has to live HERE rather than being
# installed into a running container: the testnet fleet ran for twelve days on a
# hand-built `testnet-validator-claude` image, the v0.16.0 roll rebuilt the tag
# from this file, and the binary silently vanished. Every seated hub then
# answered `spawn claude ENOENT`, so every llm request on BTC testnet expired
# with zero responses until 2026-09-09 . Pinned for the same reason the
# base tag is: a floating install moves the runtime with no signal.
RUN npm install -g @anthropic-ai/claude-code@2.1.266

COPY ./src /XChainHub/src
COPY ./docs /XChainHub/docs
# No .env is baked in: configuration reaches the container as environment
# (xchain-node at `docker run`, a standalone run via `--env-file .env`). An
# optional `COPY ./.en[v]` glob here builds only under BuildKit (issue 23).

# Exec-form node, not `npm run api` (which is this exact command). npm builds an
# npm -> sh -c -> node tree and no wrapper forwards signals, so `docker stop`
# kills npm while node is never told anything (measured on the regtest encoder,
# xchain-encoder/Dockerfile). The hub registers a real graceful shutdown on
# SIGTERM/SIGINT (src/api.js: WebSocket drain, server.close, hub.close pool
# drain, observability flush), which only runs when node is PID 1.
CMD ["node", "./src/api.js"]
