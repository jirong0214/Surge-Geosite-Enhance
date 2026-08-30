FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY worker ./worker
COPY server ./server
RUN npm run build:server && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG TARGETARCH
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl jq \
  && rm -rf /var/lib/apt/lists/*

# The updater needs both compilers so every Cloudflare feature remains
# available on a VPS. Versions are resolved at image-build time for amd64/arm64.
RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) sing_arch="amd64"; mihomo_arch="amd64" ;; \
    arm64) sing_arch="arm64"; mihomo_arch="arm64" ;; \
    *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  sing_version="$(curl -fsSL https://api.github.com/repos/SagerNet/sing-box/releases/latest | jq -r '.tag_name' | sed 's/^v//')"; \
  curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v${sing_version}/sing-box-${sing_version}-linux-${sing_arch}.tar.gz" -o /tmp/sing-box.tgz; \
  tar -xzf /tmp/sing-box.tgz -C /tmp; \
  install -m 0755 "/tmp/sing-box-${sing_version}-linux-${sing_arch}/sing-box" /usr/local/bin/sing-box; \
  mihomo_tag="$(curl -fsSL https://api.github.com/repos/MetaCubeX/mihomo/releases/latest | jq -r '.tag_name')"; \
  mihomo_version="${mihomo_tag#v}"; \
  curl -fsSL "https://github.com/MetaCubeX/mihomo/releases/download/${mihomo_tag}/mihomo-linux-${mihomo_arch}-v${mihomo_version}.gz" -o /tmp/mihomo.gz; \
  gunzip /tmp/mihomo.gz; \
  install -m 0755 /tmp/mihomo /usr/local/bin/mihomo; \
  rm -rf /tmp/sing-box* /tmp/mihomo*

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY scripts ./scripts
COPY --from=build /app/server.bundle.mjs ./server.bundle.mjs

ENV NODE_ENV=production \
    DATA_ROOT=/data \
    PORT=8787
EXPOSE 8787
CMD ["node", "server.bundle.mjs"]
