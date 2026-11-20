import type { Hono } from 'hono';
import {
  SettingsUpdateRequestSchema,
  type SettingsResponse,
  type SettingsUpdateResponse,
} from '../../../shared/dto.ts';
import type { AccountSettings } from '../../commands/index.ts';
import { readJson } from '../body.ts';

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
    settings.update(SettingsUpdateRequestSchema.parse(await readJson(c)));
    const res: SettingsUpdateResponse = { ok: true, ...settings.view() };
    return c.json(res);
  });
}
