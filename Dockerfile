FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache curl

# Dependencies
FROM base AS deps
COPY package*.json ./
COPY services/api/package*.json ./services/api/
RUN npm ci --workspace=services/api --include-workspace-root

# Builder
FROM deps AS builder
COPY . .
RUN cd services/api && npx prisma generate
RUN cd services/api && npm run build

# Production
FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/services/api/dist ./dist
COPY --from=builder /app/services/api/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/services/api/node_modules ./node_modules

EXPOSE 4000
CMD ["node", "dist/index.js"]
