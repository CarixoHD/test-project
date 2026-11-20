# Node.js v22.22.1 throws `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"` when running `node scripts/foo.ts` (ESM package, "type": "module"). Type stripping was unflagged in Node 22.18. What causes this on 22.22.x? Specifically: (1) do Debian/Ubuntu distro `nodejs` packages (apt) build Node without amaro / with type stripping disabled (check process.features.typescript)? (2) Does NODE_OPTIONS=--no-experimental-strip-types or other settings produce exactly this error? (3) Is passing `--experimental-strip-types` explicitly on 22.18+ harmless (warnings?) and does it fix a NODE_OPTIONS disable? (4) What's the cleanest robust fallback for a project whose server runs .ts directly (e.g. preflight check of process.features.typescript with a clear message, or falling back to tsx/`--import` loader)?

Date: 2026-11-20 · Confidence: medium

## Recommendation

Run `command -v node; node -v; node -p process.features.typescript; echo $NODE_OPTIONS` on the owner's machine. If it prints false and the path is /usr/bin/node, the cause is the apt build without amaro. Replace it with an official Node 22.18+ build (nvm/fnm, the nodejs.org tarball, or the node:22 Docker image) and pin the version. If NODE_OPTIONS contains --no-experimental-strip-types, remove it. Add a plain-JS (.mjs) preflight check of process.features.typescript with a clear error message to the npm scripts and server entry. Don't rely on --experimental-strip-types as the fix, because it fails on amaro-less builds. Optionally keep tsx as a documented fallback.

## Findings

Most likely cause: the `node` on the owner's PATH is the Debian/Ubuntu apt build (e.g. 22.22.1+dfsg+~cs22.19.15-1ubuntu1), which is built WITHOUT amaro. Amaro is the bundled type-stripper. Debian dropped it in Dec 2024 (22.12.0+dfsg-1) because it needs swc, and later changelog entries kept it off. A March 2026 entry says the patch was dropped "solved upstream", but the reported Ubuntu build still lacks amaro. Source: DEV article "Node 22.22 runs TypeScript. Ubuntu's Node 22.22 doesn't." I did not run this myself or check Debian's changelog directly, so treat the Debian/Ubuntu specifics as one secondary source.

(1) Yes, per that report. On that build `process.features.typescript === false` and `process.config.variables.node_use_amaro === false`. The official nodejs.org 22.22.1 build prints `'strip'` and `true`. The version string is identical, so it doesn't tell you which build you have. Diagnose with `node -p "process.features.typescript"`, `node -p "process.config.variables.node_use_amaro"`, `command -v node` and `node -p process.execPath`. Also look at `echo $NODE_OPTIONS`. In a type:module package a `.ts` file then fails with ERR_UNKNOWN_FILE_EXTENSION. The DEV article reports this error from test runs on the affected build.

(2) Yes. `--no-experimental-strip-types`, whether on the command line or in NODE_OPTIONS or a Docker ENV, turns stripping off. Node 22.18+ then gives ERR_UNKNOWN_FILE_EXTENSION for .ts, and `process.features.typescript` is false. This is a known workaround people use for ts-node/ts-mocha breakage on 22.18 (nodejs/node#59364). One PR reproduced the error with `node --no-experimental-strip-types --test` and confirmed that adding `--experimental-strip-types` fixed it. Both causes give the same error, so check `process.features.typescript` and NODE_OPTIONS separately.

(3) On an official build, passing `--experimental-strip-types` on 22.18+ is a harmless no-op (the flag is needed on 22.6–22.17). A later flag on the command line overrides an earlier one in NODE_OPTIONS, so it also undoes a NODE_OPTIONS disable. I didn't verify whether it prints a warning. The ExperimentalWarning for type stripping was removed or reduced in the 22.18 unflagging, but that is unconfirmed. On the Ubuntu amaro-less build the flag does NOT help. It throws ERR_NO_TYPESCRIPT (per the DEV article).

(4) Recommended fallbacks, in order:
a) Fix the runtime. Use an official Node build: nodejs.org tarball, nvm/fnm/volta, NodeSource, or the `node:22` Docker image. The DEV author extracted the official tarball into /usr/local, which comes before /usr/bin in PATH, and all tests passed. Pin it with .nvmrc, `engines`, and `.node-version`.
b) Add a preflight check that runs before anything else. It must be plain JS (`.mjs` or `.cjs`), because it has to run even when .ts can't. For example, `node scripts/preflight.mjs && node scripts/build-images.ts`, or a tiny `.mjs` bootstrap that checks and then does `await import('./build-images.ts')`. Check `process.features.typescript` (it should be 'strip' or 'transform') and print a clear message. The message should include `process.version`, `process.execPath`, and the `NODE_OPTIONS` value. It should say to use the official Node build, or to unset `--no-experimental-strip-types`. Also check `process.config.variables.node_use_amaro`, and require a minimum version of at least 22.18 (or 22.6 with the flag).
c) Use tsx as an optional fallback, not the primary path: `node --import tsx scripts/foo.ts` or `npx tsx`. It is a devDependency and works on any Node. The cost is that the server then has two execution paths. Install `amaro` as an external loader (`node --experimental-strip-types --import=amaro/strip`) only as a last resort. It was untested on the Debian build, and the amaro README documents the same flag (an issue shows it failing on v20).

Other cautions: type stripping does not work for files under node_modules (a different error, ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). It also needs explicit `.ts` extensions in imports, and erasable-only syntax (no enums or namespaces unless `--experimental-transform-types`). Type stripping became stable in Node 24.12 and 25.2.

## Sources

- [Node 22.22 runs TypeScript. Ubuntu's Node 22.22 doesn't. - DEV Community](https://dev.to/mk023/node-2222-runs-typescript-ubuntus-node-2222-doesnt-1pn8)
- [nodejs/node PR #55323: fix process.features.typescript when Amaro is unavailable](https://github.com/nodejs/node/pull/55323)
- [nodejs/node issue #59364: node 22.18 breaks npm package because of experimental-strip-types](https://github.com/nodejs/node/issues/59364)
- [Node.js 22.18.0 (LTS) release notes](https://nodejs.org/en/blog/release/v22.18.0)
- [PR #40 morrisstephon51/ai-video-reel-generator: run render tests under --experimental-strip-types](https://github.com/morrisstephon51/ai-video-reel-generator/pull/40)
- [nodejs/amaro issue #344](https://github.com/nodejs/amaro/issues/344)
