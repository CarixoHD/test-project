# 0006. Container isolation: docker CLI, warm per-attempt sandbox, masked .git, host-only git, network policy

Date: 2026-11-19 · Status: Accepted

## Context

Agents must run in Docker, isolated from the host. They get no Docker socket and no host filesystem beyond their worktree. The host is the owner's Linux, WSL2 or macOS machine. Products need dependency installs, while checks should be reproducible.

## Options considered

- **docker CLI via execFile + pure buildRunArgs**: Follows the active docker context on all platforms; security flags are unit-testable without Docker; one process per call.
- **dockerode 5**: Typed API and events, but socket-path differences across Desktop, OrbStack and Colima; builds still need the CLI.
- **Container per tool call**: Simple, but 500 ms+ per call, which adds up over hundreds of calls per issue.
- **Docker Sandboxes (sbx microVMs)**: Stronger isolation; possible later behind the ContainerRuntime interface.

## Decision

ContainerRuntime has two implementations: DockerCliRuntime (execFile argv; `docker buildx build` for images) and FakeContainerRuntime (tests and demo). Each attempt gets one warm container (`sleep infinity`) and every tool call is a `docker exec`. buildRunArgs (pure, unit-tested) always applies the following:
- `--init`, the host uid:gid, `--cap-drop ALL`, `no-new-privileges`, `--read-only` with tmpfs for /tmp and $HOME, memory/cpu/pids limits, and `--restart no`
- `vibecode.*` labels and the deterministic name `vibecode-<runId>`
- exactly one bind: the worktree at /workspace (read-only for reviewers and previews), with an empty read-only file over /workspace/.git
- refusal of any docker.sock mount and of any source outside data/worktrees
All git operations run on the host with hooks and fsmonitor disabled. Networks:
- implementer and orchestrator: `vibecode-egress` bridge with ICC off (so they can install packages)
- checks, merge re-checks and API-backed reviewers: `none`
- previews: `vibecode-preview`, with the port published on 127.0.0.1 only
Product images are built from the repo's Dockerfile and tagged by sha256 of the Dockerfile plus `.vibecode/project.json` imageInputs (lockfiles). Dependencies install outside /workspace (/node_modules, /opt/venv), so a bind-mounted worktree still resolves them. The fallback image is vibecode/base (Debian, git, node, python). On boot, recovery removes every vibecode.managed container and all worktrees.

## Rationale

The research names the writable .git as the most likely escape path. Masking .git and keeping git on the host closes it. Making buildRunArgs pure lets the PRD's security tests (no socket, mount confinement, no secret env) run in `npm test` without Docker. The CLI avoids socket-path issues on WSL2 and macOS. Warm containers make tool calls cheap. Running checks with network none in an image built from lockfiles gives reproducible verdicts. Implementers keep egress so they can add dependencies. That is acceptable because no secrets enter API-backed containers; the egress allowlist proxy is a follow-up.

## Sources

- [Research: per-agent Docker containers with worktrees](docs/research/what-is-the-safest-robust-way-to-orchestrate-per-a.md)
- [Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/)
