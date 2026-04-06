FROM node:latest

RUN mkdir /XChainHub/
COPY ./package.json /XChainHub/package.json
WORKDIR /XChainHub
RUN npm install

COPY ./src /XChainHub/src
COPY ./.en[v] /XChainHub/.env

CMD ["npm", "run", "api"]
