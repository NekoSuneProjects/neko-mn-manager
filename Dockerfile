FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TS_NODE_TRANSPILE_ONLY=1
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
EXPOSE 8080
CMD ["node", "--loader", "ts-node/esm", "src/server/main.ts"]
