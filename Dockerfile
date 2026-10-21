# Send to Scribe server. Build from the repo root: the server reuses extension/lib.
FROM oven/bun:1.4.2-slim

# ffmpeg converts article images (WebP, AVIF, large PNG) to Kindle-friendly JPEG.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/bun.lock server/bunfig.toml ./server/
RUN cd server && bun install --frozen-lockfile --production
COPY extension/lib ./extension/lib
COPY server ./server

# The named volume copies this directory's ownership on first use, so the bun user can write to it.
RUN mkdir -p /data && chown bun:bun /data
WORKDIR /app/server
ENV DATA_DIR=/data PORT=3000
USER bun
CMD ["bun", "index.js"]
