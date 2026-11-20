import { resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { ensureDataDir, parseConfig, type Config } from './config.ts';
import { open } from './db/index.ts';
import { createGit } from './git/index.ts';
import { createApp } from './http/index.ts';
import { redactor } from './security/index.ts';
import { createStore } from './store/index.ts';
import { systemClock } from './util/clock.ts';
import { createIdGen } from './util/id-gen.ts';

const DEFAULT_WEB_ROOT = resolve(import.meta.dirname, '../../dist/web');

export interface Running {
  /** The address actually bound (port 0 resolves to a free port). */
  address: { host: string; port: number };
  close(): Promise<void>;
}

/** Composition root: config → data dir → DB → store → app → serve. */
export async function start(config: Config, webRoot = DEFAULT_WEB_ROOT): Promise<Running> {
  ensureDataDir(config.dataDir);
  const db = open(config.dbPath);
  const store = createStore({ db, clock: systemClock, redactor });
  const git = createGit({ dataDir: config.dataDir });
  const ids = createIdGen(systemClock);
  const app = createApp({ store, ids, git, redactor, webRoot });

  const { server, address } = await new Promise<{
    server: ServerType;
    address: { host: string; port: number };
  }>((done) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
      done({ server: s, address: { host: info.address, port: info.port } });
    });
  });

  return {
    address,
    close: () =>
      new Promise<void>((done, fail) => {
        // SSE streams never end on their own: drop open connections so close() can finish.
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close((err) => {
          db.$client.close();
          if (err) fail(err);
          else done();
        });
      }),
  };
}

if (import.meta.main) {
  const running = await start(parseConfig(process.env));
  const { host, port } = running.address;
  console.log(`Vibecode listening on http://${host}:${String(port)}`);
}
