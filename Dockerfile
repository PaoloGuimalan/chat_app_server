FROM node:22-alpine

WORKDIR /app

COPY .env .env
COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3001

CMD [ "node", "index.js" ]