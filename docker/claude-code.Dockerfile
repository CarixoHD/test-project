# vibecode/claude-code: the pinned, unmodified Claude Code CLI layered on an image (ADR 4).
# - BASE_IMAGE=vibecode/base gives `vibecode/claude-code`, the image of the one-time login command.
# - BASE_IMAGE=<product image> gives the derived image Claude-backed runs use; the product image
#   must be Debian/glibc. DockerCliRuntime builds both on first use.
# The CLI comes with its own Node, so it does not depend on (or change) the product's Node.
# Login state lives only in the vibecode-claude-config volume at /home/agent/.claude, which
# Vibecode mounts but never reads. Build by hand: `npm run docker:claude-code`.
ARG BASE_IMAGE=vibecode/base
ARG CLAUDE_CODE_VERSION=2.1.329

FROM node:22-bookworm-slim AS cli
ARG CLAUDE_CODE_VERSION
RUN npm install --global --no-fund --no-audit --prefix /opt/claude-code \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && cp /usr/local/bin/node /opt/claude-code/node

FROM ${BASE_IMAGE}
USER root
COPY --from=cli /opt/claude-code /opt/claude-code
# `claude` runs the CLI with its bundled Node; falls back to the package's own launcher.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'cli=/opt/claude-code/lib/node_modules/@anthropic-ai/claude-code/cli.js' \
      'if [ -f "$cli" ]; then exec /opt/claude-code/node "$cli" "$@"; fi' \
      'PATH="/opt/claude-code:$PATH" exec /opt/claude-code/bin/claude "$@"' \
      > /usr/local/bin/claude \
 && chmod 0755 /usr/local/bin/claude \
 && mkdir -p /home/agent/.claude /workspace \
 && chmod 1777 /home/agent \
 && chown 1000:1000 /home/agent/.claude \
 && chmod 0700 /home/agent/.claude

ENV HOME=/home/agent \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    DISABLE_AUTOUPDATER=1

# Non-root. Vibecode runs containers as the host uid:gid; the login command runs as uid 1000,
# which owns the volume (see README if your uid is not 1000).
USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
