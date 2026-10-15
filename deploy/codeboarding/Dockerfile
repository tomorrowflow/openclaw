# CodeBoarding analysis engine (https://github.com/CodeBoarding/CodeBoarding).
# Language servers are installed at build time so runs never download them.
FROM python:3.12-slim-bookworm

ARG CODEBOARDING_VERSION=0.15.1
ARG UID=1000
ARG GID=1000

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd -g ${GID} cb && useradd -m -u ${UID} -g ${GID} cb
USER cb
ENV PATH=/home/cb/.local/bin:$PATH \
    CODEBOARDING_TELEMETRY=false \
    DO_NOT_TRACK=1

RUN pip install --user --no-cache-dir "codeboarding==${CODEBOARDING_VERSION}" \
 && codeboarding-setup

WORKDIR /repos
ENTRYPOINT ["codeboarding"]
CMD ["--help"]
