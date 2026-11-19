# What is the safest robust way to orchestrate per-agent Docker containers with git worktrees from a Node or Python host? Cover: Docker SDK options (dockerode, docker-py), mounting only the worktree, no Docker socket inside containers, network policy, resource limits, cleanup and recovery after a host restart, building per-product Dockerfiles, and running a preview container on a local port. Include what to do on WSL2, macOS and Linux.

Date: 2026-11-19 · Confidence: medium

## Recommendation

Use a Node host with dockerode 5.0.x, or Python with docker 7.2.x, for the container lifecycle and events. Shell out to `docker buildx build` (argv array) for images, tagged by a content hash.

Every agent/check container:
- Bind-mounts only its worktree at /workspace, with /workspace/.git masked.
- Runs as the host uid:gid, CapDrop ALL, no-new-privileges, ReadonlyRootfs plus tmpfs.
- Has Memory/NanoCpus/PidsLimit set, NetworkMode none (or an internal network plus an allowlist egress proxy when needed), RestartPolicy no.
- Never gets the Docker socket.

The host does all git operations, with hooks/fsmonitor disabled.

Label everything slopper.*. On startup, run a reconciler that kills/removes orphans by label, marks interrupted runs retryable, and prunes/repairs worktrees.

Previews: a read-only worktree mount, published only on 127.0.0.1 with HostPort 0, a health-checked URL and an idle TTL.

Platforms:
- Linux: rootless or userns-remap, plus gVisor.
- WSL2: native Engine in the distro with systemd, repos on the ext4 side, mirrored networking.
- macOS: Docker Desktop/OrbStack via Docker context, dependencies in volumes.

Keep a container-runtime adapter interface so Docker Sandboxes (sbx microVMs) can be added later as a higher-isolation backend.

## Findings

CONTEXT (as of 2026-11-19): Docker Engine 29.9.3 (Nov 3 2026), Docker Desktop 4.100.0. Node SDK dockerode 5.0.1 (Jun 24 2026, about 5M weekly downloads, maintained). Python SDK docker (docker-py) 7.2.0. Its from_env() now follows the active Docker CLI context, and it adds from_context(). Default API version 1.45.

1) SDK CHOICE
- dockerode and docker-py both cover the container lifecycle well: create/start/inspect/wait/logs/kill/remove, label filters and events.
- Image builds are the weak spot in both. docker-py's images.build uses the legacy builder with no BuildKit. dockerode's buildImage({version:'2'}) does open a BuildKit session, but:
  - It still uploads a tar context.
  - Builds intermittently hung until the gRPC health-service fix (PR #847).
  - Secrets support only landed in Oct 2026 (PR #854).
- So shell out to `docker buildx build` (argv array, no shell string) for builds, and use the SDK for everything else. Pin the API version and connect through a Docker context or DOCKER_HOST. Don't hard-code /var/run/docker.sock: on macOS Docker Desktop it is ~/.docker/run/docker.sock, and Colima/OrbStack also use different paths.

2) MOUNTING ONLY THE WORKTREE
- A linked worktree has a `.git` *file* that points (by absolute path by default) to <main>/.git/worktrees/<name>. If you mount only the worktree, git inside the container breaks. The fixes other tools use all mount the common .git into the container:
  - Mount the common .git at the identical absolute path (DataDog KMT does this).
  - Use worktree.useRelativePaths (git 2.48+, which sets extensions.relativeWorktrees and breaks older git) and mount the common dir beside the worktree. The devcontainer CLI has a --mount-git-worktree-common-dir flag for this.
- SECURITY: a writable .git is a host code-execution path. A container that can write .git/hooks, .git/config (core.fsmonitor, core.hooksPath, filter/diff drivers) or other worktrees' refs gets its code run the next time the host runs git (the harness, the merge step).
- Safest pattern:
  - Bind-mount only the worktree directory at /workspace.
  - Mask the .git pointer by overlaying an empty read-only file or tmpfs on /workspace/.git, so the agent can't reach the repo.
  - The host does all git operations (status, diff, add, commit, merge), with hooks disabled: `git -c core.hooksPath=/dev/null -c core.fsmonitor=false`.
  - Treat worktree content as untrusted when the host reads it.
- If agents must run git themselves, give each one an isolated `git clone --no-hardlinks` (not a worktree) and fetch from it on the host. Never mount the main .git read-write.

3) NO DOCKER SOCKET IN CONTAINERS
- Never bind /var/run/docker.sock or pass DOCKER_HOST into agent or preview containers. Socket access is root on the host. Assert this in code by rejecting any mount whose source ends in docker.sock.
- If an agent needs Docker-in-Docker, use Docker Sandboxes (sbx microVMs) or Sysbox, not the host socket.

4) HARDENING AND RESOURCE LIMITS (HostConfig, the same fields in both SDKs)
- User = host uid:gid. This matters most on Linux and WSL2 bind mounts to avoid root-owned files.
- CapDrop: ["ALL"]; SecurityOpt: ["no-new-privileges:true"] and keep the default seccomp; Privileged: false.
- ReadonlyRootfs: true, with Tmpfs for /tmp and $HOME (size-limited), and the worktree as the only writable bind.
- Memory plus MemorySwap set to the same value (no swap), NanoCpus (e.g. 2e9), PidsLimit (e.g. 512), Ulimits nofile. For disk, use a size-limited tmpfs; StorageOpt size only works on overlay2 with xfs+pquota.
- RestartPolicy "no". Init: true (tini reaps zombies).
- Enforce wall-clock timeouts from the host with kill on expiry.
- Stronger options:
  - Linux: rootless Docker or userns-remap, plus gVisor (runsc) as the Runtime for agent containers. gVisor isn't available on Docker Desktop.
  - Docker Desktop: Enhanced Container Isolation (Business tier).
  - Docker Sandboxes (sbx CLI, one microVM per agent, Linux/macOS/Windows, GA 2026) is a credible higher-isolation alternative. It brings Docker's opinionated agent flow.

5) NETWORK POLICY
- Default is NetworkMode "none" for implementers and test/check runs.
- When egress is needed (package installs), attach the container only to a per-run `internal: true` user-defined network, which has no route out. On that network, put an egress proxy container (squid/tinyproxy/Envoy with a domain allowlist such as registry.npmjs.org, pypi.org, files.pythonhosted.org, github.com) that is also attached to an outbound network. Set HTTP(S)_PROXY in the agent container.
- Better still: install dependencies in the image-build step, with network, and run agents offline.
- Block metadata/LAN ranges in the proxy.
- Don't use the default bridge (inter-container communication is on).

6) CLEANUP AND RECOVERY AFTER HOST RESTART
- Label everything (containers, networks, volumes, images): slopper.managed=1, slopper.product, slopper.issue, slopper.run_id, slopper.role=agent|preview|check.
- Keep desired state in the host DB (sqlite).
- On startup, run a reconciler:
  - List containers/networks with label filter slopper.managed=1.
  - Any container whose run_id isn't active in the DB gets killed and removed.
  - Agent and check runs interrupted by the restart are marked failed/retryable and restarted from the worktree state (the worktree survives on disk).
  - Clean up stale worktrees: `git worktree list --porcelain`, then prune, `git worktree repair`, and remove orphans.
  - Remove orphaned networks.
  - Prune images with `docker image prune --filter label=slopper.managed=1 --filter until=…`.
- RestartPolicy "no" means nothing comes back on its own after a reboot. The reconciler decides.
- Previews can be recreated on demand.
- Avoid AutoRemove for check runs: you need the exit code and logs (wait, then logs, then remove).
- Subscribe to /events filtered by label to see deaths and OOMs (State.OOMKilled).
- Use deterministic container names (slopper-<run_id>) so a crashed host can't double-start a run (create gives 409 Conflict).

7) PER-PRODUCT DOCKERFILES
- Generate or commit Dockerfile plus .dockerignore per product, based on pinned base images (by digest).
- Build with `docker buildx build --label slopper.managed=1 -t slopper/<product>:<hash-of-lockfiles+Dockerfile>`. Use the content hash as the tag so rebuilds are cached and skipped. Use cache mounts (`RUN --mount=type=cache`) for npm/pip, and `--network=none` for steps after the dependency install.
- The image holds the toolchain and dependencies only. Source arrives at run time through the worktree bind mount.
- Never use secrets as ARG. Use `--secret` (CLI) or dockerode version:'2' secrets.
- The build context is untrusted: build with the default BuildKit sandbox, never `--allow security.insecure`, and no host-network entitlement.

8) PREVIEW CONTAINER ON A LOCAL PORT
- Use the same image, worktree mounted **read-only** (or a built artifact), and its own internal network.
- PortBindings {"<appPort>/tcp":[{"HostIp":"127.0.0.1","HostPort":"0"}]}, then inspect NetworkSettings.Ports to get the assigned port.
- ALWAYS bind 127.0.0.1. On Linux, published ports are DNATed before UFW's INPUT chain, so a `-p 8080:80` was reachable from the LAN despite UFW (third-party test on Engine 29.9.3/Ubuntu 26.04). ip6tables is on since Engine 27, so check IPv6 too. Engine 29 has an experimental nftables backend with no DOCKER-USER chain.
- Add a healthcheck and poll the HTTP health endpoint before reporting the URL. Enforce an idle TTL and one preview per product.

9) PLATFORM NOTES
- Linux: native Engine. Best is rootless Docker or userns-remap, plus gVisor for agent runs. Pass uid:gid. Bind-mount speed is native. Watch the UFW/iptables issue above.
- WSL2 (this host is WSL2):
  - Run the orchestrator inside the WSL distro, either with native Docker Engine in the distro or Docker Desktop's WSL integration.
  - Keep repos and worktrees on the Linux filesystem (~/...), never /mnt/c (9P is very slow, and permission/inotify issues break watchers and previews).
  - A 127.0.0.1 port in WSL reaches Windows through localhost forwarding or mirrored networking mode (.wslconfig networkingMode=mirrored).
  - Cap the VM's memory and CPU in .wslconfig.
  - Enable systemd (/etc/wsl.conf) so dockerd starts after WSL restarts. The reconciler must also run when WSL shuts down (`wsl --shutdown`, Windows reboot).
- macOS: Docker Desktop (VirtioFS file sharing), OrbStack or Colima. Everything runs in a Linux VM, so:
  - The socket path differs: resolve it with a Docker context.
  - Bind mounts are slower: keep node_modules and similar in named volumes or the image, not the bind mount.
  - uid mapping is handled by the VM.
  - 127.0.0.1 port publishing works to the Mac host.
  - gVisor isn't available. Use Docker Sandboxes or ECI for more isolation.
  - Only paths in the file-sharing list can be mounted.

RISKS: the git-metadata escape (item 2) is the most likely real-world hole. Next are Linux port exposure and socket leakage through a careless mount. Dockerode BuildKit sessions are recently fixed and less proven than the CLI.

## Sources

- [dockerode v5.0.1 release](https://newreleases.io/project/github/apocas/dockerode/release/v5.0.1)
- [dockerode Snyk package page](https://security.snyk.io/package/npm/dockerode)
- [dockerode PR #847 BuildKit session health](https://github.com/apocas/dockerode/pull/847)
- [dockerode PR #821 build secrets](https://github.com/apocas/dockerode/pull/821)
- [testcontainers-node BuildKit issue #571](https://github.com/testcontainers/testcontainers-node/issues/571)
- [Docker SDK for Python changelog (stable)](https://docker-py.readthedocs.io/en/stable/change-log.html)
- [git-worktree manual](https://www.kernel.org/pub/software/scm/git/docs/git-worktree.html)
- [DataDog kmt worktree container mount PR](https://github.com/DataDog/datadog-agent/pull/60922)
- [avocado-cli worktree common dir mount PR](https://github.com/avocado-linux/avocado-cli/pull/328)
- [Docker Sandboxes product page](https://www.docker.com/products/docker-sandboxes/)
- [InfoQ: Harbor adds Docker Sandboxes](https://www.infoq.com/news/2026/10/ai-agents-harbor-docker/)
- [Docker UFW firewall fix (Engine 29 tested)](https://www.virtua.cloud/learn/en/tutorials/docker-ufw-firewall-fix-vps)
- [ufw-docker](https://github.com/chaifeng/ufw-docker)
