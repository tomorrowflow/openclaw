FROM debian:trixie-slim@sha256:4e401d95de7083948053197a9c3913343cd06b706bf15eb6a0c3ccd26f436a0e

ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,id=openclaw-sandbox-trixie-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-sandbox-trixie-apt-lists,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    ripgrep \
    unzip

# Deno is not packaged in Debian apt; install the official release binary
# system-wide so it is on PATH for the unprivileged sandbox user.
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) deno_target="x86_64-unknown-linux-gnu" ;; \
    arm64) deno_target="aarch64-unknown-linux-gnu" ;; \
    *) echo "unsupported arch for deno: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/denoland/deno/releases/latest/download/deno-${deno_target}.zip" -o /tmp/deno.zip; \
  unzip -o /tmp/deno.zip -d /usr/local/bin; \
  rm /tmp/deno.zip; \
  chmod +x /usr/local/bin/deno; \
  deno --version

# Base image Python is externally-managed (PEP 668); install curl_cffi into the
# system interpreter so sandbox scripts can import it.
RUN pip3 install --no-cache-dir --break-system-packages curl_cffi

RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox

CMD ["sleep", "infinity"]
