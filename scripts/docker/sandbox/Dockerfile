FROM debian:trixie-slim@sha256:28de0877c2189802884ccd20f15ee41c203573bd87bb6b883f5f46362d24c5c2

ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,id=openclaw-sandbox-trixie-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-sandbox-trixie-apt-lists,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    bat \
    ca-certificates \
    curl \
    fd-find \
    ffmpeg \
    file \
    gh \
    git \
    imagemagick \
    jq \
    nodejs \
    npm \
    pandoc \
    poppler-utils \
    python3 \
    python3-pip \
    ripgrep \
    rsync \
    sqlite3 \
    tree \
    unzip \
    wget \
    yq \
    zip

# Debian renames these two to avoid clashes, but every agent and every snippet
# on the web calls them fd and bat. Link the conventional names onto PATH.
RUN ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && ln -s /usr/bin/batcat /usr/local/bin/bat

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
