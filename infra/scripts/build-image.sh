#!/usr/bin/env bash
# Build the Keel image with every pin sourced from infra/versions.lock.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source infra/versions.lock; set +a
TAG="$(git rev-parse --short HEAD)"
# TARGETARCH is BuildKit-only auto-arg; legacy builder leaves it unset.
# Passing explicitly is builder-agnostic (BuildKit honors the override).
case "$(uname -m)" in
  x86_64) TARCH=amd64;;
  aarch64|arm64) TARCH=arm64;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1;;
esac
sudo docker build ${NOCACHE} \
  --build-arg BASE_IMAGE="${UBUNTU_BASE_IMAGE}@${UBUNTU_BASE_DIGEST}" \
  --build-arg NODE_VERSION="${NODE_VERSION}" \
  --build-arg NODE_SHA256_X64="${NODE_SHA256_LINUX_X64}" \
  --build-arg NODE_SHA256_ARM64="${NODE_SHA256_LINUX_ARM64}" \
  --build-arg CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION}" \
  --build-arg TARGETARCH="${TARCH}" \
  -f infra/docker/Dockerfile \
  -t "keel:${TAG}" -t keel:latest .
echo "BUILT keel:${TAG}"
