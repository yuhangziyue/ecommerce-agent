# ⚠️ 本机没有 Docker，此文件**未经构建验证**（见 docs/iterations/v1.0-production/REPORT.md）。
# 首次使用前请自行 `docker build` 验证。

FROM node:20-alpine AS base
WORKDIR /app
# tsx 直接跑 TS，不做编译产物 —— 与 npm run serve 的行为完全一致，
# 避免「本地跑的是 TS、线上跑的是编译产物」这种双轨差异
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY tsconfig.json ./

# 非 root 运行
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV NODE_ENV=production
EXPOSE 3000

# 健康检查用 /healthz —— 它在 draining 时会转 503，
# 正是编排系统停止派新流量的信号
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server.ts"]
