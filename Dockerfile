# Dockerfile portável — roda igual no Fly.io, Railway, Render (Docker) ou local.
# ── Stage 1: build ────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
# --include=dev: precisa de prisma CLI + typescript pro build. postinstall roda `prisma generate`.
RUN npm ci --include=dev
COPY . .
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
# Copia node_modules (com prisma client já gerado), build, schema e estáticos.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/public ./public
COPY package.json ./
EXPOSE 3000
# migrate deploy é idempotente; aplica o schema antes de subir o servidor.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
