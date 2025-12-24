FROM node:20-bullseye-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TS_NODE_TRANSPILE_ONLY=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 8080
CMD ["node", "--loader", "ts-node/esm", "src/server/main.ts"]
