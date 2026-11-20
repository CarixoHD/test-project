import type { Hono } from 'hono';
import {
  SettingsUpdateRequestSchema,
  type SettingsResponse,
  type SettingsUpdateResponse,
} from '../../../shared/dto.ts';
import type { AccountSettings } from '../../commands/index.ts';
import { fail } from '../errors.ts';

/**
 * GET|PUT /api/settings (ARCHITECTURE §4.3): account-wide settings. API keys are write-only:
 * reads show only provider + last 4 characters; PUT sets (string) or clears (null) them.
 */
export function registerSettingsRoutes(app: Hono, settings: AccountSettings): void {
  app.get('/api/settings', (c) => {
    const body: SettingsResponse = settings.view();
    return c.json(body);
  });

  app.put('/api/settings', async (c) => {
    const body: unknown = await c.req
      .json()
      .catch(() => fail({ ok: false, reason: 'The body must be JSON' }));
    settings.update(SettingsUpdateRequestSchema.parse(body));
    const res: SettingsUpdateResponse = { ok: true, ...settings.view() };
    return c.json(res);
  });
}
