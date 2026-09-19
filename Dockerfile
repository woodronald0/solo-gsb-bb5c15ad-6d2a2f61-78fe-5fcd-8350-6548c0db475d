# syntax=docker/dockerfile:1

# 论证稳定性沙盘 all-in-one 镜像：构建前端静态资源 + 编译后端 + 精简生产依赖。
# 构建：docker build -t argument-stability-sandbox .
# 运行：docker run -p 8080:8080 -v argument-sqlite-data:/app/data argument-stability-sandbox
# （推荐直接使用根目录的 docker-compose.yml：docker compose up --build）

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

# 健康检查：命中 /api/health，Compose 会继承该配置并展示容器健康状态。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null 2>&1 || exit 1

# 启动命令：单进程同时提供 /api/* 接口与 dist/ 前端静态资源。
CMD ["node", "dist-server/server/index.js"]
