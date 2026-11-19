import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { z } from 'zod';

const DEFAULT_WEB_ROOT = resolve(import.meta.dirname, '../../dist/web');

export interface AppOptions {
  /** Directory with the built SPA. Served only when it exists. */
  webRoot?: string;
}

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  const webRoot = options.webRoot;
  if (webRoot !== undefined && existsSync(webRoot)) {
    app.use('*', serveStatic({ root: webRoot }));
    // SPA fallback: client-side routes get index.html; unknown /api paths stay 404.
    app.get('*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) return next();
      return serveStatic({ root: webRoot, path: 'index.html' })(c, next);
    });
  }

  return app;
}

const ListenEnv = z.object({
  VIBECODE_HOST: z.string().min(1).default('127.0.0.1'),
  VIBECODE_PORT: z.coerce.number().int().min(1).max(65_535).default(4317),
});

export interface ListenConfig {
  host: string;
  port: number;
}

export function readListenConfig(env: Record<string, string | undefined>): ListenConfig {
  const parsed = ListenEnv.parse(env);
  return { host: parsed.VIBECODE_HOST, port: parsed.VIBECODE_PORT };
}

if (import.meta.main) {
  const { host, port } = readListenConfig(process.env);
  const app = createApp({ webRoot: DEFAULT_WEB_ROOT });
  serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`Vibecode listening on http://${info.address}:${String(info.port)}`);
  });
}
