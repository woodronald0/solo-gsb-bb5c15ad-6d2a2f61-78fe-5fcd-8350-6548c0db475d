# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

# better-sqlite3 在无预编译包时需要少量原生构建工具。
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json ./
COPY client ./client
COPY server ./server
COPY shared ./shared
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DATABASE_PATH=./data/argument.db

RUN apk add --no-cache libstdc++

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server

RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 8080
VOLUME ["/app/data"]

CMD ["node", "dist-server/server/index.js"]
