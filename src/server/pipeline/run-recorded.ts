import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AGENT_EXIT_OUTCOMES } from '../../shared/domain.ts';
import type { EventOf } from '../../shared/events.ts';
import type { AgentId, AttemptId, IdGen, IssueId, ProductId } from '../../shared/ids.ts';
import { runAgent, type AgentResult, type AgentSpec, type StepUsage } from '../agents/index.ts';
import type { Store } from '../store/index.ts';
import type { Clock } from '../util/clock.ts';
import { ActivityBatcher, realSetTimer, type SetTimer } from './activity-batcher.ts';
import { readPriceOverrides } from './settings.ts';
import { usageCost } from './usage.ts';

type ExitOutcome = (typeof AGENT_EXIT_OUTCOMES)[number];
export type UsageRecorded = EventOf<'usage.recorded'>;

export interface RecordedRunContext {
  store: Store;
  ids: IdGen;
  clock: Clock;
  redactor: { redact(text: string): string };
  /** `data/logs`: each agent writes `<agentId>.ndjson` here. */
  logsDir: string;
  /** Timer for flushing held activity lines; defaults to `setTimeout`. */
  setTimer?: SetTimer;
  /** Runs after every committed `usage.recorded` (budget checks hook in here). */
  afterUsage?: (event: UsageRecorded) => void;
}

/** What the caller decides; ids, clock and the activity/usage callbacks come from the wrapper. */
export type RecordedAgentSpec<T> = Omit<
  AgentSpec<T>,
  'agentId' | 'clock' | 'onActivity' | 'onUsage'
> & {
  productId: ProductId;
  issueId?: IssueId;
  attemptId?: AttemptId;
};

export type RecordedRun<T> = { agentId: AgentId; result: AgentResult<T> };

/** Log file of an agent: NDJSON lines `{ts, line}`, redacted. */
export function agentLogPath(logsDir: string, agentId: AgentId): string {
  return path.join(logsDir, `${agentId}.ndjson`);
}

/**
 * Runs one agent with full recording (ARCHITECTURE §4.6): `agent.spawned`, a redacted log
 * file, batched `agent.activity`, one `usage.recorded` per step, `agent.state` rate_limited,
 * and always `agent.exited`, also when the run throws. Failures inside the recording
 * callbacks (store, log file, `afterUsage`) stop the agent and are rethrown after it ends.
 */
export async function runRecordedAgent<T>(
  ctx: RecordedRunContext,
  spec: RecordedAgentSpec<T>,
): Promise<RecordedRun<T>> {
  const { store, clock, redactor } = ctx;
  const { productId, issueId = null, attemptId = null, ...agentSpec } = spec;
  const agentId = ctx.ids.next('agent');
  const scope = { productId, entityId: agentId, v: 1 } as const;

  store.commit(() => [
    {
      ...scope,
      type: 'agent.spawned',
      data: { role: spec.role, model: spec.model, issueId, attemptId },
    },
  ]);

  const logFile = agentLogPath(ctx.logsDir, agentId);
  const log = (line: string) => {
    const entry = JSON.stringify({ ts: clock.now(), line: redactor.redact(line) });
    appendFileSync(logFile, `${redactor.redact(entry)}\n`, { mode: 0o600 });
  };
  const batcher = new ActivityBatcher({
    clock,
    setTimer: ctx.setTimer ?? realSetTimer,
    emit: (lines) =>
      store.commit(() => [
        { ...scope, type: 'agent.activity', data: { lines: lines.map((l) => redactor.redact(l)) } },
      ]),
  });

  // A failing recording callback must not be mistaken for a model error by the agent loop:
  // remember it, stop the agent, and rethrow once the run has ended.
  let failure: { error: unknown } | undefined;
  const guard =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      if (failure !== undefined) return;
      try {
        fn(...args);
      } catch (error) {
        failure = { error };
      }
    };

  const recordUsage = (u: StepUsage) => {
    const overrides = readPriceOverrides(store);
    const [event] = store.commit(() => [
      {
        type: 'usage.recorded',
        productId,
        entityId: ctx.ids.next('usage'),
        v: 1,
        data: {
          agentId,
          role: spec.role,
          model: spec.model,
          issueId,
          attemptId,
          ...usageCost(spec.model, u, overrides),
        },
      },
    ]);
    if (event?.type === 'usage.recorded') ctx.afterUsage?.(event);
  };

  let outcome: ExitOutcome = 'error';
  let exitLine = 'exited error';
  try {
    mkdirSync(ctx.logsDir, { recursive: true, mode: 0o700 });
    const result = await runAgent<T>({
      ...agentSpec,
      agentId,
      clock,
      shouldStop: () => failure !== undefined || agentSpec.shouldStop(),
      onActivity: guard((line: string) => {
        log(line);
        batcher.push(line);
      }),
      onUsage: guard(recordUsage),
    });
    if (failure !== undefined) throw failure.error;
    if (result.kind === 'rate_limited') {
      store.commit(() => [
        { ...scope, type: 'agent.state', data: { state: 'rate_limited', until: result.until } },
      ]);
    }
    outcome = result.kind;
    exitLine = `exited ${outcome}${result.kind === 'error' ? `: ${result.message}` : ''}`;
    return { agentId, result };
  } catch (error) {
    exitLine = `exited error: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  } finally {
    try {
      batcher.close();
      log(exitLine);
    } finally {
      store.commit(() => [{ ...scope, type: 'agent.exited', data: { outcome } }]);
    }
  }
}
