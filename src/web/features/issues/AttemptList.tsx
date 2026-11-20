import { useId, useMemo, useState } from 'react';
import type { AgentView, AttemptState } from '../../../shared/state.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { StatusBadge, Tabs } from '../../ui/index.ts';
import { LiveLog, roleLabel } from '../agents/index.ts';
import {
  ATTEMPT_STATUS_BADGE,
  ATTEMPT_STEP_LABEL,
  countedText,
  formatDateTime,
} from './attempt-text.ts';
import { DiffView } from './DiffView.tsx';
import { useAttemptArtifact, type ArtifactResult } from './use-attempt-artifact.ts';

const TAB_IDS = ['log', 'diff', 'check', 'review'] as const;
type TabId = (typeof TAB_IDS)[number];
const TAB_LABEL: Record<TabId, string> = {
  log: 'Log',
  diff: 'Diff',
  check: 'Check output',
  review: 'Review',
};
const isTabId = (id: string): id is TabId => (TAB_IDS as readonly string[]).includes(id);

const selectAgents = (s: AppSnapshot) => s.state.agents;

/** Every attempt of an issue (newest first), each with its log, diff, check output and review. */
export function AttemptList({ attempts }: { attempts: readonly AttemptState[] }) {
  if (attempts.length === 0) return <p>No attempts yet.</p>;
  return (
    <ol className="attempt-list">
      {attempts.map((a) => (
        <li key={a.id}>
          <AttemptItem attempt={a} />
        </li>
      ))}
    </ol>
  );
}

function AttemptItem({ attempt }: { attempt: AttemptState }) {
  const headingId = useId();
  const [tab, setTab] = useState<TabId>('log');
  const badge = ATTEMPT_STATUS_BADGE[attempt.status];
  // Only the open tab renders content, so hidden tabs neither stream logs nor fetch artifacts.
  const content = (id: TabId) => (tab === id ? <AttemptTab attempt={attempt} tab={id} /> : null);
  return (
    <section className="attempt" aria-labelledby={headingId}>
      <h3 id={headingId}>Attempt {attempt.n}</h3>
      <dl className="attempt__facts">
        <dt>Status</dt>
        <dd>
          <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
        </dd>
        <dt>Counting</dt>
        <dd>{countedText(attempt)}</dd>
        <dt>Step</dt>
        <dd>{ATTEMPT_STEP_LABEL[attempt.step]}</dd>
        <dt>Started</dt>
        <dd>
          <time dateTime={new Date(attempt.startedAt).toISOString()}>
            {formatDateTime(attempt.startedAt)}
          </time>
        </dd>
        <dt>Ended</dt>
        <dd>
          {attempt.endedAt === null ? (
            'Still running'
          ) : (
            <time dateTime={new Date(attempt.endedAt).toISOString()}>
              {formatDateTime(attempt.endedAt)}
            </time>
          )}
        </dd>
      </dl>
      {attempt.feedback !== null && (
        <div className="attempt__feedback">
          <h4>Feedback</h4>
          <pre className="attempt__text">{attempt.feedback}</pre>
        </div>
      )}
      <Tabs
        label={`Attempt ${String(attempt.n)} details`}
        items={TAB_IDS.map((id) => ({ id, label: TAB_LABEL[id], content: content(id) }))}
        selectedId={tab}
        onSelect={(id) => {
          if (isTabId(id)) setTab(id);
        }}
      />
    </section>
  );
}

function AttemptTab({ attempt, tab }: { attempt: AttemptState; tab: TabId }) {
  switch (tab) {
    case 'log':
      return <AttemptLogs attempt={attempt} />;
    case 'diff':
      return <ArtifactView attempt={attempt} kind="diff" />;
    case 'check':
      return <ArtifactView attempt={attempt} kind="check" />;
    case 'review':
      return <ReviewView attempt={attempt} />;
  }
}

/** The logs of every agent that worked on the attempt (implementer, then reviewer). */
function AttemptLogs({ attempt }: { attempt: AttemptState }) {
  const agents = useApp(selectAgents);
  const own = useMemo(
    () =>
      Object.values(agents)
        .filter((a): a is AgentView => a !== undefined && a.attemptId === attempt.id)
        .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)),
    [agents, attempt.id],
  );
  if (own.length === 0) return <p>No agent has worked on this attempt yet.</p>;
  return (
    <>
      {own.map((agent) => (
        <div key={agent.id} className="attempt__log">
          <h4>{roleLabel(agent.role)}</h4>
          <LiveLog agentId={agent.id} label={`${roleLabel(agent.role)} log`} />
        </div>
      ))}
    </>
  );
}

const MISSING_TEXT = { diff: 'No diff yet.', check: 'No check output yet.' } as const;

function ArtifactView({ attempt, kind }: { attempt: AttemptState; kind: 'diff' | 'check' }) {
  // Refetch as the attempt advances: the diff and check output are written during the run.
  const version = `${attempt.step}/${attempt.status}`;
  const result: ArtifactResult = useAttemptArtifact(attempt.id, kind, version);
  switch (result.status) {
    case 'loading':
      return <p>Loading…</p>;
    case 'missing':
      return <p>{MISSING_TEXT[kind]}</p>;
    case 'error':
      return <p role="alert">Could not load: {result.message}</p>;
    case 'ready':
      return kind === 'diff' ? (
        <DiffView text={result.text} />
      ) : (
        <>
          {attempt.checkExit !== null && <p>Exit code {attempt.checkExit}</p>}
          <pre className="attempt__text">{result.text}</pre>
        </>
      );
  }
}

function ReviewView({ attempt }: { attempt: AttemptState }) {
  const { review } = attempt;
  if (review === null) {
    return <p>{attempt.endedAt === null ? 'No review yet.' : 'This attempt was not reviewed.'}</p>;
  }
  return (
    <>
      <p>
        <StatusBadge tone={review.approve ? 'success' : 'danger'}>
          {review.approve ? 'Approved' : 'Changes requested'}
        </StatusBadge>
      </p>
      {review.findings.length === 0 ? (
        <p>No findings.</p>
      ) : (
        <ul className="attempt__findings">
          {review.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </>
  );
}
