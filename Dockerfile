FROM node:latest

RUN mkdir /XChainHub/
COPY ./package.json /XChainHub/package.json
COPY ./package-lock.json /XChainHub/package-lock.json
WORKDIR /XChainHub
RUN npm ci --omit=dev

COPY ./src /XChainHub/src
COPY ./docs /XChainHub/docs
COPY ./.en[v] /XChainHub/.env

CMD ["npm", "run", "api"]
