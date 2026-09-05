# ---- build ----
FROM node:22-bookworm-slim AS build
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- runtime ----
FROM node:22-bookworm-slim
RUN corepack enable
ENV NODE_ENV=production TZ=Asia/Tokyo
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/web/package.json apps/web/
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules apps/server/node_modules
COPY --from=build /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/drizzle apps/server/drizzle
COPY --from=build /app/apps/web/dist apps/web/dist
ENV DATA_DIR=/data PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
