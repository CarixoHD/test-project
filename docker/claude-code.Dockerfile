# vibecode/claude-code: the pinned, unmodified Claude Code CLI layered on an image (ADR 4).
# BASE_IMAGE is a required build arg. Its default is a sentinel tag that never exists, so a build
# without it fails loudly instead of using a stale image. DockerCliRuntime passes it, and
# `npm run -s docker:images` prints the build commands with it filled in (pipe to `sh` to build).
# - BASE_IMAGE=vibecode/base:<base-hash> gives `vibecode/claude-code:<hash>`, the image of the one-time
#   login command. The hash covers this file, so bumping CLAUDE_CODE_VERSION yields a new tag and a rebuild.
# - BASE_IMAGE=<product image> gives the derived image Claude-backed runs use; the product image
#   must be Debian/glibc. DockerCliRuntime builds both on first use.
# The CLI comes with its own Node, so it does not depend on (or change) the product's Node.
# Login state lives only in the vibecode-claude-config volume at /home/agent/.claude, which
# Vibecode mounts but never reads. Build by hand: `npm run -s docker:images`, or copy the build
# command from Settings → Claude Code.
# Valid-but-nonexistent default: silences InvalidDefaultArgInFrom, fails if --build-arg is forgotten.
ARG BASE_IMAGE=vibecode/base:set-BASE_IMAGE-build-arg
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
 && chmod 1777 /home/agent /home/agent/.claude

ENV HOME=/home/agent \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    DISABLE_AUTOUPDATER=1

# Non-root. Vibecode runs containers as the host uid:gid, and so does the login command
# (`--user <uid>:<gid>`, built by the server), so the agents can read the login. A fresh volume
# copies /home/agent/.claude's mode (1777, sticky), so any host uid can write the login into it;
# the CLI keeps its credential files private to that uid.
USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
