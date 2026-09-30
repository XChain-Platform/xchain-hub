# Pinned by digest to the node:22.23.2-bookworm build whose V8/ICU match
# xchain-vm's consensus runtime pin: the floating node:22-bookworm tag moved
# to a Node patch that fails that check, so a tag alone can silently drift
# the image off the runtime the fleet requires.
FROM node:22.23.2-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844

RUN mkdir /XChainHub/
COPY ./package.json /XChainHub/package.json
COPY ./package-lock.json /XChainHub/package-lock.json
WORKDIR /XChainHub
RUN npm ci --omit=dev

# The llm attestation provider's default transport spawns this CLI by name
# (src/providers/llm/claude_spawn.js: CLAUDE_BIN, default `claude`), which
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
# The consensus-identity pin assets: src/api/rpc/system.js reads
# bin/lib/carrier_logic_pin.js and bin/pins/carrier-logic.json at startup to
# publish carrier_logic_digest in /health, and neither lived in the image
# before this COPY (only ./src and ./docs did).
COPY ./bin /XChainHub/bin
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
