# Top Chicken labeller.
# Stage 1: build the off-the-shelf bsky-watch/labeler binary (signs via indigo,
# the same lib the AppView ingester verifies with — no signature mismatch class).
# Use a current Go (the upstream-pinned 1.22.6 compiler segfaults building the
# logging package under emulation/newer hosts; 1.23.x is API-compatible here).
FROM golang:1.23 AS builder
WORKDIR /src
COPY vendor-labeler/go.mod vendor-labeler/go.sum ./
RUN go mod download
COPY vendor-labeler/ ./
RUN go build -trimpath -o /out/labeler ./cmd/labeler

# Stage 2: runtime — the labeler binary + our Python poller in one container.
FROM debian:stable-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 netcat-openbsd wget \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /out/labeler /app/labeler
COPY config.template.yaml poller.py entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh
ENV NODE_ENV=production
ENTRYPOINT ["/app/entrypoint.sh"]
