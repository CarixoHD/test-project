# Lessons

Short lessons from building this product, written by Slopper when work needed fixing. Read them before you start: they save you from mistakes earlier agents made.

- (#203) The test-honesty landmine covers every changed test file, so an old `vi.stubGlobal('fetch', vi.fn(...))` pattern fires as soon as you touch the file; rewrite network fakes with `msw/node` (`msw` is only an optional peer of vitest and must be added as a devDependency).
- (milestone review) Test helpers that work around environment quirks (zombies, env vars from the sandbox) should be checked in both directions: assert the probe says 'alive' before the action and 'gone' after it, so a probe that always returns one answer cannot pass.
- (milestone review) When a test depends on SDK behaviour that reads process.env (for example ANTHROPIC_BASE_URL), pin the variable with vi.stubEnv and rely on the unstubEnvs config, rather than assuming a clean environment.
- (milestone review) When adding a dependency, install it with `npm i -D --save-exact` so package.json gets an exact version as CODING_STANDARDS §1 requires; the caret default slips past typecheck, lint and tests.
- (milestone review) Before changing access rules, check the request's own Host as well as the bind address: behind Tailscale serve or a reverse proxy the server binds loopback but the client is remote.
