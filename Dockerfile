FROM node:22-alpine

RUN apk add --no-cache \
    python3 \
    py3-pip \
    make \
    g++ \
    linux-headers \
    pkgconfig

WORKDIR /app

# COPY .env .env
COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3001

CMD [ "node", "index.js" ]