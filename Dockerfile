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

COPY ./src /XChainHub/src
COPY ./docs /XChainHub/docs
COPY ./.en[v] /XChainHub/.env

# Exec-form node, not `npm run api` (which is this exact command). npm builds an
# npm -> sh -c -> node tree and no wrapper forwards signals, so `docker stop`
# kills npm while node is never told anything (measured on the regtest encoder,
# xchain-encoder/Dockerfile). The hub registers a real graceful shutdown on
# SIGTERM/SIGINT (src/api.js: WebSocket drain, server.close, hub.close pool
# drain, observability flush), which only runs when node is PID 1.
CMD ["node", "./src/api.js"]
