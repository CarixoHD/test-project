# vibecode/base: fallback image for products without a Dockerfile (ARCHITECTURE §4.8, ADR 6).
# Debian slim + git + Node 22 LTS + python3 with a venv at /opt/venv on PATH.
# Containers run as the host uid:gid with a read-only rootfs and a tmpfs HOME at /home/agent.
# Built on first use by DockerCliRuntime, or by hand: `npm run docker:base`.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv \
 && mkdir -p /home/agent /workspace \
 && chmod 1777 /home/agent

ENV HOME=/home/agent \
    PATH=/opt/venv/bin:$PATH \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /workspace
CMD ["sleep", "infinity"]
