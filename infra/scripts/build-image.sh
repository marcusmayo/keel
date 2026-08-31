#!/usr/bin/env bash
# Build the Keel image with every pin sourced from infra/versions.lock.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source infra/versions.lock; set +a
TAG="$(git rev-parse --short HEAD)"
# The builder is CHOSEN here, not inherited. Without the buildx plugin `docker build` falls back
# to the legacy builder that engine 29 deprecated -- same image today, a different builder from
# the rest of the fleet, and nothing in the output that says which one you got. Assert it.
if ! sudo docker buildx version >/dev/null 2>&1; then
  echo "FATAL: docker buildx is not installed -- this image is built with BuildKit." >&2
  echo "  install: sudo apt-get -o DPkg::Lock::Timeout=420 install -y docker-buildx" >&2
  exit 1
fi
# TARGETARCH is a BuildKit auto-arg; passing it explicitly keeps the Dockerfile honest about
# what it is building for and survives a --platform build unchanged.
case "$(uname -m)" in
  x86_64) TARCH=amd64;;
  aarch64|arm64) TARCH=arm64;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1;;
esac
# The commit this image is built FROM, derived from git alone. Deliberately not reusing TAG:
# TAG falls back to a date when git is unavailable, and a twelve-digit date passes the shape of
# a sha -- an image would then report a build time as its provenance. A dirty tree is marked,
# because "this image contains code that was never committed" is the useful part.
SOURCE_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ "$SOURCE_COMMIT" != unknown ] && ! git diff --quiet HEAD 2>/dev/null; then SOURCE_COMMIT="${SOURCE_COMMIT}-dirty"; fi
sudo docker buildx build ${NOCACHE:-} \
  --build-arg BASE_IMAGE="${UBUNTU_BASE_IMAGE}@${UBUNTU_BASE_DIGEST}" \
  --build-arg NODE_VERSION="${NODE_VERSION}" \
  --build-arg NODE_SHA256_X64="${NODE_SHA256_LINUX_X64}" \
  --build-arg NODE_SHA256_ARM64="${NODE_SHA256_LINUX_ARM64}" \
  --build-arg CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION}" \
  --build-arg TARGETARCH="${TARCH}" \
  --build-arg SOURCE_COMMIT="${SOURCE_COMMIT}" \
  -f infra/docker/Dockerfile \
  -t "keel:${TAG}" -t keel:latest .
echo "BUILT keel:${TAG}  from ${SOURCE_COMMIT}  (buildx $(sudo docker buildx version | awk '{print $2}'))"
