// Dev runner (docs/ARCHITECTURE.md §8): API in demo mode on 127.0.0.1:$PORT+1 with `node --watch`,
// Vite on 0.0.0.0:$PORT proxying /api to it. Stops both on exit.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { devApiOrigin } from './dev-proxy.mjs';
import { chooseContainerRuntime, containerRuntimeLabel } from './dev-runtime.mjs';
import { nodeProblem } from './preflight.mjs';

// The API child runs .ts via Node type stripping (ADR 0012): refuse to start without it.
const problem = nodeProblem({
  version: process.version,
  typescript: process.features.typescript,
  execPath: process.execPath,
  nodeOptions: process.env.NODE_OPTIONS,
});
if (problem !== null) {
  console.error(problem);
  process.exit(1);
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = '.data/dev';

const uiPort = Number(process.env.PORT ?? '5173');
if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65_534) {
  console.error(`PORT must be an integer between 1 and 65534, got "${process.env.PORT}"`);
  process.exit(1);
}
const apiPort = uiPort + 1;

mkdirSync(new URL(`../${DATA_DIR}`, import.meta.url), { recursive: true });

// Claude Code needs a real container runtime, so use Docker when the daemon answers (issue #206).
const dockerReachable = await new Promise((resolve) => {
  execFile('docker', ['info'], { timeout: 2_000 }, (err) => {
    resolve(err === null);
  });
});
const containers = chooseContainerRuntime(process.env, dockerReachable);

const api = spawn(process.execPath, ['--watch', 'src/server/main.ts'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    VIBECODE_HOST: '127.0.0.1',
    VIBECODE_PORT: String(apiPort),
    VIBECODE_DEMO: '1',
    VIBECODE_FAKE_DOCKER: containers === 'fake' ? '1' : '',
    VIBECODE_DATA_DIR: DATA_DIR,
  },
});

const vite = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  server: {
    host: '0.0.0.0',
    port: uiPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        // Present /api requests to the loopback-only API as local, whatever Host the browser used.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin = devApiOrigin(req.headers.host, req.headers.origin, apiPort);
            if (origin !== undefined) proxyReq.setHeader('origin', origin);
          });
          // Keep SSE streaming: tell any intermediary not to buffer or transform event streams.
          proxy.on('proxyRes', (res) => {
            if (String(res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
              res.headers['cache-control'] = 'no-cache, no-transform';
              res.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
});

let isStopping = false;
async function stop(code) {
  if (isStopping) return;
  isStopping = true;
  if (api.exitCode === null) api.kill('SIGTERM');
  await vite.close();
  process.exit(code);
}

api.on('exit', (code, signal) => {
  if (isStopping) return;
  console.error(`API process exited (${signal ?? `code ${code}`}); stopping dev server.`);
  void stop(code ?? 1);
});
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
process.on('exit', () => {
  if (api.exitCode === null) api.kill('SIGTERM');
});

await vite.listen();
console.log(`Vibecode dev: UI http://0.0.0.0:${uiPort}  API http://127.0.0.1:${apiPort}`);
console.log(containerRuntimeLabel(containers, dockerReachable));
