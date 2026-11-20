# 0012. Keep native Node type stripping; add a plain-JS preflight instead of a tsx fallback

Date: 2026-11-20 · Status: Accepted

## Context

The owner's Node v22.22.1 failed with ERR_UNKNOWN_FILE_EXTENSION on .ts entry points. Debian/Ubuntu apt builds of Node ship without amaro, so they have no type stripping, and NODE_OPTIONS=--no-experimental-strip-types gives the same error. The server and all scripts run .ts directly (ADR 0002).

## Options considered

- **tsx loader fallback**: Run every entry point through tsx or --import tsx. This works on any Node, but it adds a second execution path and a dependency for a host misconfiguration.
- **Add a server build step**: Compile to JS. This reverses ADR 0002 and adds build complexity.
- **Preflight check + docs (chosen)**: A plain .mjs check runs before any .ts loads. It detects missing type stripping or an old Node and prints exact remedies: install an official Node build, or remove the NODE_OPTIONS flag.

## Decision

Keep native type stripping as the only execution path. npm scripts and dev.mjs run scripts/preflight.mjs first. .nvmrc pins Node 22. The docs require an official Node build.

## Rationale

The cause lies in the host's Node build, not in our code. A clear one-line diagnosis fixes it permanently for the owner. A loader fallback would hide the problem and double the paths we have to test.

## Sources

- [Node 22.22 runs TypeScript. Ubuntu's Node 22.22 doesn't.](https://dev.to/mk023/node-2222-runs-typescript-ubuntus-node-2222-doesnt-1pn8)
- [nodejs/node PR #55323: process.features.typescript when Amaro is unavailable](https://github.com/nodejs/node/pull/55323)
- [nodejs/node issue #59364](https://github.com/nodejs/node/issues/59364)
