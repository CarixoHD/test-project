import { useEffect, useId, useState } from 'react';
import type { BackendLimit } from '../../../shared/state-schema.ts';
import { ApiError, clearBackendLimit } from '../../state/api.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { Button, StatusBadge, type BadgeTone } from '../../ui/index.ts';
import { ClaudeTokenField } from './ClaudeTokenField.tsx';
import { useClaudeLogin } from './use-claude-login.ts';

const BACKEND = 'claude-code';

/** The setup steps, in order; their text comes from the server (its uid:gid and image tag). */
const STEPS = [
  { id: 'build', what: 'the build command' },
  { id: 'volume', what: 'the volume command' },
  { id: 'login', what: 'the login command' },
] as const;

const selectLimit = (s: AppSnapshot): BackendLimit | undefined => s.state.backendLimits[BACKEND];

type Status = { tone: BadgeTone; label: string; detail: string };

const formatTime = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const MAX_TIMER_MS = 2 ** 31 - 1;

/** The `until` (if any) that has passed: a timer re-renders the status when the limit resets. */
function useExpiredUntil(until: number | null | undefined): number | null {
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (until == null) return undefined;
    const t = setTimeout(
      () => setExpired(until),
      Math.min(MAX_TIMER_MS, Math.max(0, until - Date.now())),
    );
    return () => clearTimeout(t);
  }, [until]);
  return expired;
}

/** OK / needs login / rate limited until …, from the account-wide backend limits. */
function statusOf(limit: BackendLimit | undefined, expiredUntil: number | null): Status {
  if (limit?.needsLogin === true) {
    return {
      tone: 'danger',
      label: 'Needs login',
      detail:
        'Claude Code runs are paused until you log in again. Paste a new subscription token above, or run the terminal login command and press "I\'ve logged in".',
    };
  }
  if (limit !== undefined && limit.until === null) {
    return {
      tone: 'warning',
      label: 'Rate limited',
      detail: 'Claude Code runs are paused until the limit resets.',
    };
  }
  if (limit?.until != null && limit.until !== expiredUntil) {
    return {
      tone: 'warning',
      label: `Rate limited until ${formatTime(limit.until)}`,
      detail: 'Claude Code runs resume on their own after that.',
    };
  }
  return { tone: 'success', label: 'OK', detail: 'No login problem or rate limit is reported.' };
}

/**
 * Claude Code (subscription) backend (ADR 4, ADR 13): the subscription token, the live status from
 * `backendLimits`, "I've logged in" to clear needs_login, and the terminal login as an alternative.
 */
export function ClaudeCodeSection() {
  const headingId = useId();
  const limit = useApp(selectLimit);
  const status = statusOf(limit, useExpiredUntil(limit?.until));
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const setup = useClaudeLogin();
  const { commands } = setup;

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`Copied ${what}.`);
    } catch {
      setNotice(`Could not copy ${what}: select it and copy it by hand.`);
    }
  };

  const loggedIn = async () => {
    setClearing(true);
    setError(null);
    try {
      await clearBackendLimit(BACKEND);
      setNotice('Marked Claude Code as logged in. Paused runs start again.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach Vibecode. Try again.');
    } finally {
      setClearing(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className="settings-section">
      <h2 id={headingId}>Claude Code</h2>
      <p className="settings-section__intro">
        Use your Claude Pro or Max subscription by choosing the Claude Code provider for a role.
        Agents then run the official Claude Code CLI inside their containers, logged in with your
        own account. Paste a subscription token below: Vibecode stores it only on this machine,
        never shows it again, and only gives it to the Claude Code CLI. Logging in from a terminal
        still works as an alternative.
      </p>

      <ClaudeTokenField />

      <h3>Status</h3>
      <p className="settings-claude__status">
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge> <span>{status.detail}</span>
      </p>
      {limit?.needsLogin === true ? (
        <div className="settings-actions">
          <Button
            variant="primary"
            onClick={() => void loggedIn()}
            aria-disabled={clearing}
            disabled={clearing}
          >
            I've logged in
          </Button>
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="ui-field__error">
          {error}
        </p>
      ) : null}

      <details className="settings-claude__terminal">
        <summary>Alternative: log in from a terminal</summary>
        <p>
          Run these in a terminal on the machine that runs Vibecode: build the image, create the
          volume, then log in. The login runs as your own user, like the agents. Log in again the
          same way whenever Claude Code reports that the login expired.
        </p>
        {setup.error !== null ? (
          <p role="alert" className="ui-field__error">
            {setup.error}
          </p>
        ) : null}
        {commands !== null ? (
          <ol className="settings-claude__steps">
            {STEPS.map((step) => (
              <li key={step.id}>
                <code className="settings-claude__command">{commands[step.id]}</code>
                <Button
                  aria-label={`Copy ${step.what}`}
                  onClick={() => void copy(step.what, commands[step.id])}
                >
                  Copy
                </Button>
              </li>
            ))}
          </ol>
        ) : null}
        {commands === null && setup.error === null ? <p>Loading the setup commands…</p> : null}
      </details>
      <p role="status" className="settings-notice">
        {notice}
      </p>
    </section>
  );
}
