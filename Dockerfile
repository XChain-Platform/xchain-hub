FROM node:latest

RUN mkdir /XChainHub/
RUN mkdir /data/
COPY ./package.json /XChainHub/package.json
WORKDIR /XChainHub
RUN npm install

COPY ./src /XChainHub/src
COPY ./.en[v] /XChainHub/.env

CMD ["npm", "run", "api"]