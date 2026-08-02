# Keel runtime image. Build via infra/scripts/build-image.sh (passes pins
# from infra/versions.lock). Image = code, immutable; state = volumes.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG NODE_VERSION
ARG NODE_SHA256_X64
ARG NODE_SHA256_ARM64
ARG CLAUDE_CODE_VERSION
ARG TARGETARCH

RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Node: official tarball, SHA256-verified against versions.lock (fail-loud).
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) A=x64;   H="${NODE_SHA256_X64}";; \
      arm64) A=arm64; H="${NODE_SHA256_ARM64}";; \
      *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1;; \
    esac; \
    T="node-v${NODE_VERSION}-linux-${A}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${T}"; \
    echo "${H}  ${T}" | sha256sum -c -; \
    tar -xJf "${T}" -C /usr/local --strip-components=1; rm "${T}"

# claude CLI: exact version; npm enforces registry sha512 integrity.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Python deps: hash-enforced. Container is the isolation boundary, so
# system site-packages via --break-system-packages is deliberate.
COPY infra/docker/requirements.txt /tmp/requirements.txt
RUN python3 -m pip install --break-system-packages --require-hashes \
      -r /tmp/requirements.txt && rm /tmp/requirements.txt

RUN useradd -m -u 10001 keel
WORKDIR /app

# webchat deps from lockfile only.
COPY webchat/package.json webchat/package-lock.json /app/webchat/
RUN cd /app/webchat && npm ci --omit=dev

# Code whitelist (context filtering already blocked residue + service.env).
COPY tools/ /app/tools/
COPY gate/ /app/gate/

# Fleet-core drift gate (gate/): vendored gate modules must byte-match agent-fleet-iac/core/gate.
RUN bash /app/gate/verify-core.sh /app/gate
COPY scripts/ /app/scripts/

# Fleet-core drift gate: vendored shared module must byte-match agent-fleet-iac/core.
RUN bash /app/scripts/verify-core.sh /app/scripts
COPY .claude/ /app/.claude/
COPY webchat/ /app/webchat/
COPY system/ /app/system/
COPY keel.config.json CLAUDE.md /app/

# Demo harness (synthetic Northwind generator + one-command runner + reset).
# Baked in so a stranger can run `docker exec <container> bash run_e2e.sh --yes` with no clone mount.
COPY examples/ /app/examples/
COPY run_e2e.sh clean_demo.sh /app/

# Test harness (fixture tests for ingestion lanes; run via docker exec).
COPY tests/ /app/tests/

# Runtime state mount points, writable by keel whether or not volumes mount.
RUN mkdir -p /app/state /app/knowledge /app/logs /app/support \
    && chown -R keel:keel /app

USER keel
ENV NODE_ENV=production PYTHONUNBUFFERED=1
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://127.0.0.1:8443/health/liveliness >/dev/null || exit 1
CMD ["node", "webchat/server.js"]
