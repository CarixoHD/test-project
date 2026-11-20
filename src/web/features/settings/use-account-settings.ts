import { useCallback, useEffect, useState } from 'react';
import type { SettingsResponse } from '../../../shared/dto.ts';
import { ApiError, getSettings } from '../../state/api.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';

export interface AccountSettingsView {
  settings: SettingsResponse | null;
  /** Why the last load failed; null once a load succeeds. */
  error: string | null;
  /** Takes the settings a successful PUT answered with. */
  replace: (next: SettingsResponse) => void;
}

const selectChangedAt = (s: AppSnapshot) => s.state.settingsChangedAt;

/**
 * GET /api/settings, fetched again whenever `ClientState.settingsChangedAt` moves (a
 * `settings.changed` event from another tab or the server), so the page stays live.
 */
export function useAccountSettings(): AccountSettingsView {
  const changedAt = useApp(selectChangedAt);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getSettings(controller.signal).then(
      (next) => {
        setSettings(next);
        setError(null);
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : 'Could not load the settings.');
      },
    );
    return () => controller.abort();
  }, [changedAt]);

  const replace = useCallback((next: SettingsResponse) => {
    setSettings(next);
    setError(null);
  }, []);

  return { settings, error, replace };
}
