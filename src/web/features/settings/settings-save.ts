import {
  SettingsUpdateRequestSchema,
  type SettingsResponse,
  type SettingsUpdateRequest,
} from '../../../shared/dto.ts';
import { ApiError, updateSettings } from '../../state/api.ts';

/** What every settings section gets: the current settings and where saved ones go. */
export interface SettingsSectionProps {
  settings: SettingsResponse;
  onSaved: (next: SettingsResponse) => void;
}

/** The first validation message for `body` (the server applies the same schema), else null. */
export function invalidReason(body: SettingsUpdateRequest): string | null {
  const parsed = SettingsUpdateRequestSchema.safeParse(body);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Invalid value');
}

/** PUTs `body` and hands the resulting settings to `onSaved`. Returns an error message or null. */
export async function saveSettings(
  body: SettingsUpdateRequest,
  onSaved: SettingsSectionProps['onSaved'],
): Promise<string | null> {
  try {
    const { ok: _ok, ...next } = await updateSettings(body);
    onSaved(next);
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.message : 'Could not save the settings.';
  }
}
