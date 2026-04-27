FROM node:18-alpine AS builder
WORKDIR /app
COPY . .
RUN npm install -g pnpm && pnpm install --no-frozen-lockfile
RUN pnpm build:web

FROM node:18-alpine AS runtime
WORKDIR /app
RUN npm install express@5
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server

ENV PORT=3000
ENV MD_DIR=/docs
EXPOSE 3000

CMD ["node", "server/index.js"]
