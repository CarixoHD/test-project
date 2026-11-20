import { ClaudeCodeSection } from './ClaudeCodeSection.tsx';
import { PasswordSection } from './PasswordSection.tsx';
import { ProvidersSection } from './ProvidersSection.tsx';
import { useAccountSettings } from './use-account-settings.ts';

/** `/settings`: providers and keys, models per role, price overrides, Claude Code, password. */
export function SettingsPage() {
  const { settings, error, replace } = useAccountSettings();
  return (
    <>
      <h1>Settings</h1>
      {error !== null ? (
        <p role="alert" className="ui-field__error">
          {error}
        </p>
      ) : null}
      {settings === null ? (
        error === null ? (
          <p role="status">Loading settings…</p>
        ) : null
      ) : (
        <div className="settings">
          <ProvidersSection settings={settings} onSaved={replace} />
        </div>
      )}
      <ClaudeCodeSection />
      <PasswordSection />
    </>
  );
}
