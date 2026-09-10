FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
COPY migrations ./migrations
COPY templates ./templates
RUN mkdir -p /var/lib/wiki/blobs && chown -R bun:bun /var/lib/wiki
USER bun
CMD ["bun", "run", "src/runtime/api.ts"]
