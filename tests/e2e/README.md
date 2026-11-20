Playwright browser tests (`npm run test:e2e`). Install the browser first with `npx playwright install --with-deps chromium`; `global-setup.ts` stops the run with that hint when Chromium cannot start.

`playwright.config.ts` builds the SPA and runs `node src/server/main.ts` in demo mode (`VIBECODE_DEMO=1`, `VIBECODE_FAKE_DOCKER=1`) on a fresh temp `VIBECODE_DATA_DIR`: no API keys, no Docker. Specs are typechecked with `tsconfig.e2e.json` (DOM lib).

- `board.spec.ts`: serial; the first test creates the product the others continue with. Covers create → spar → handoff → issues Completed without reload, add/edit/cancel, an SSE outage caught up by a snapshot reload, and the inbox.
