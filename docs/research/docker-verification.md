# Docker verification (#173, #177)

Real-daemon verification of the images and the container security policy (ADR 0006), run in the
product sandbox's own Docker daemon (Docker Engine 29.10.0).

## #173 results

- Both images (`vibecode/base`, `vibecode/claude-code`) build with no warnings.
- The `BASE_IMAGE` sentinel build fails as intended.
- The Claude image prints `2.1.329 (Claude Code)`.
- Containers run as uid 1000.
- The sandbox has internet, so the egress test ran and passed (not the no-internet path of #152).
- `npm run test:docker`: 3 of 12 tests failed, all because `DockerCliRuntime.ensureNetworks()`
  could not create `vibecode-egress` and threw a generic `Could not create the Docker network
  vibecode-egress`. The 3 are the tests that need the networks: runtime "writes files into the
  worktree owned by the host uid" (egress), pipeline "commits work done in containers…"
  (implementers run on egress) and pipeline "previews current main…" (ensureNetworks creates
  egress before preview).

## Cause: no br_netfilter on the host

At the start of #177, `/proc/sys/net/bridge` did not exist, and creating an ICC-off bridge
failed. Captured with
`docker network create --opt com.docker.network.bridge.enable_icc=false vibecode-egress-probe-177`
(exit 1). Daemon stderr:

```
Error response from daemon: cannot restrict inter-container communication or run without the userland proxy: stat /proc/sys/net/bridge/bridge-nf-call-iptables: no such file or directory: set environment variable DOCKER_IGNORE_BR_NETFILTER_ERROR=1 to ignore
```

A plain bridge (`docker network create vibecode-preview-probe-177`, no ICC option) was created
without error.

`DOCKER_IGNORE_BR_NETFILTER_ERROR=1` is not a fix: the network would be created, but the daemon
could not enforce ICC off, so containers on `vibecode-egress` could reach each other. The policy
stays fail-closed: no ICC-on fallback.

## What #177 changed

- `ensureNetworks` throws `IccUnsupportedError` (`code: 'DOCKER_ICC_UNSUPPORTED'`) when the
  daemon refuses the ICC-off egress bridge for this reason. The message says Docker can't turn off
  inter-container traffic on this host, gives the fix (`sudo modprobe br_netfilter`, persist it
  with `/etc/modules-load.d/br_netfilter.conf`, restart Vibecode) and quotes the redacted daemon
  stderr. It creates no other network after the failure. Other create failures keep the generic
  error.
- The message reaches the owner like `Docker is not running`: as the attempt's `error` end
  (attempt infra error, #96) or the orchestrator's inbox error item.
- `tests/docker/icc-probe.ts` probes once per suite file whether the daemon can create an ICC-off
  bridge and logs `[icc-probe] CAPABLE host …` or `[icc-probe] NOT CAPABLE host … Daemon said: …`.
  On capable hosts the 3 network tests run unchanged. On other hosts they are replaced by tests
  that assert the real runtime fails closed: `ensureNetworks` rejects with `IccUnsupportedError`
  naming `sudo modprobe br_netfilter` and leaves no `vibecode-egress`; `open` on egress rejects;
  an attempt ends with status `error` and that message, and the issue goes back to open; a
  preview is refused with that message. Nothing is skipped in either case.

## `npm run test:docker` in #177

By the time the suite ran, `br_netfilter` was loaded on the shared kernel
(`/proc/sys/net/bridge/bridge-nf-call-iptables` present, `br_netfilter` in `/proc/modules`).
Vibecode never calls modprobe; what loaded it is unknown (the daemon or another process on the
shared kernel). So this host was **capable** for the run:

- `npm run test:docker`: `[icc-probe] CAPABLE host`. 2 files, **12 passed / 12**, 0 failed,
  0 skipped. `vibecode-egress` exists with `{"com.docker.network.bridge.enable_icc":"false"}`.
- The not-capable path was exercised with a test-only `docker` shim on `PATH` that answers ICC-off
  `network create` with the stderr captured above and reports `vibecode-egress` missing, and
  passes every other command to the real daemon: `[icc-probe] NOT CAPABLE host`. 2 files,
  **12 passed / 12**, including the 3 fail-closed replacements.

Unit coverage (`src/server/sandbox/docker-cli.test.ts`, fake exec): ICC-off create fails →
`IccUnsupportedError` with the fix, exactly one create (ICC off), no preview network; the quoted
stderr is redacted; other create failures keep the generic error.

## Host requirement

`br_netfilter` must be loaded. Standard Docker Engine and Docker Desktop load it themselves; on
other hosts run `sudo modprobe br_netfilter` and add `br_netfilter` to
`/etc/modules-load.d/br_netfilter.conf`. See docs/ARCHITECTURE.md §9.
