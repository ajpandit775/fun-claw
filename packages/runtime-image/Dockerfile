# Fun Claw runtime sandbox image.
#
# This is the image Fun Claw spawns containers from at chat time —
# every tool call (execute_bash, write_file, MCP, skills) runs inside
# a container created from this image with ADR-001's hardening config
# applied (non-root uid 10001, read-only rootfs, no privileged caps,
# bridge network, CapDrop:ALL, etc.).
#
# Image strategy:
#   - Base: ubuntu:24.04 (Noble Numbat LTS, supported until 2029).
#   - Pre-creates the agent user (uid 10001, gid 10001) so the
#     docker-runner doesn't need its `--user 0:0` setup exec to
#     useradd at session start. The image is the v1 substitute for
#     that bridge.
#   - Pre-creates /workspace (uid 10001-owned, mode 0700) and /tmp
#     (mode 1777, sticky) so the entrypoint doesn't need to chmod.
#   - Bakes in the common toolchain the agent reaches for: git,
#     curl, jq, build-essential, python3, Node 22 LTS via NodeSource,
#     and pnpm via Corepack.
#   - Single RUN with --no-install-recommends + apt cache cleanup
#     to keep image size <500 MB compressed.
#
# OCI labels follow opencontainers.org/image-spec for registry
# tooling (GHCR shows them on the package page). The version,
# revision, and source labels are filled in via build args at
# `docker build` time so a single Dockerfile produces every
# released image.

FROM ubuntu:24.04

ARG VERSION=dev
ARG REVISION=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Fun Claw runtime sandbox" \
      org.opencontainers.image.description="Sandbox image for Fun Claw agent tool execution. Non-root, read-only rootfs, no privileged caps." \
      org.opencontainers.image.vendor="The Fun Claw Maintainers" \
      org.opencontainers.image.source="https://github.com/ajpandit775/fun-claw" \
      org.opencontainers.image.documentation="https://github.com/ajpandit775/fun-claw#readme" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.base.name="docker.io/library/ubuntu:24.04"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_VERSION=22 \
    PNPM_HOME=/home/agent/.local/share/pnpm \
    PATH=/home/agent/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Install common tools, Node 22 LTS via NodeSource, and pnpm via
# Corepack. Single RUN to keep layers small; --no-install-recommends
# avoids ~150 MB of suggested-but-unneeded packages; apt list cleanup
# saves another ~30 MB.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg; \
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -; \
    apt-get install -y --no-install-recommends \
        build-essential \
        git \
        jq \
        nodejs \
        python3 \
        python3-pip \
        python3-venv \
        unzip; \
    corepack enable; \
    corepack prepare pnpm@latest --activate; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    rm -rf /tmp/* /var/tmp/*

# Pre-create the agent user with the locked uid/gid 10001.
# `--no-log-init` avoids the lastlog-sparse-file gotcha on uids that
# create huge sparse /var/log/lastlog files. `--system` would mark it
# as a system user (uid <1000), but uid 10001 is intentionally above
# both the system and host-user range — out of any conflict zone.
RUN set -eux; \
    groupadd --gid 10001 agent; \
    useradd --no-log-init --uid 10001 --gid 10001 --create-home --shell /bin/bash agent; \
    install -d -o agent -g agent -m 0700 /workspace; \
    install -d -m 1777 /tmp

# Drop the entrypoint script into a stable path. It's tiny — just
# verifies /workspace and /tmp are present and writable, then execs
# whatever command the runner passed (typically `sleep infinity` for
# Fun Claw chat sessions, since the runner uses `exec` for tool
# invocations rather than the container's CMD).
COPY entrypoint.sh /usr/local/bin/funclaw-entrypoint.sh
RUN chmod 0755 /usr/local/bin/funclaw-entrypoint.sh

USER 10001:10001
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/funclaw-entrypoint.sh"]
CMD ["sleep", "infinity"]
