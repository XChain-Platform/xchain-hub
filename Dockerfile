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

CMD ["npm", "run", "api"]
