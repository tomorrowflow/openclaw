#!/usr/bin/env bash
set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:-openclaw-sandbox:trixie-slim}"
TARGET_IMAGE="${TARGET_IMAGE:-openclaw-sandbox-research:trixie-slim}"
FINAL_USER="${FINAL_USER:-sandbox}"

# Ensure the base sandbox image exists.
if ! docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
  echo "Base image missing: ${BASE_IMAGE}"
  echo "Building base image via scripts/sandbox-setup.sh..."
  scripts/sandbox-setup.sh
fi

echo "Building research sandbox: ${TARGET_IMAGE}"

docker build \
  -t "${TARGET_IMAGE}" \
  -f Dockerfile.sandbox-research \
  --build-arg BASE_IMAGE="${BASE_IMAGE}" \
  --build-arg FINAL_USER="${FINAL_USER}" \
  .

cat <<NOTE
Built ${TARGET_IMAGE}.
To use it, set agents.defaults.sandbox.docker.image to "${TARGET_IMAGE}" and restart.
If you want a clean re-create, remove old sandbox containers:
  docker rm -f \$(docker ps -aq --filter label=openclaw.sandbox=1)
NOTE
