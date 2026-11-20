import { join, resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { ensureDataDir, parseConfig, type Config } from './config.ts';
import { open } from './db/index.ts';
import { createGit } from './git/index.ts';
import { createApp } from './http/index.ts';
import { inboxHook } from './notify/index.ts';
import { createScheduler, type Runners } from './scheduler/index.ts';
import { createAccountSettings, createSparring, type SparTurnRunner } from './commands/index.ts';
import type { FakeScript, ModelDeps } from './llm/index.ts';
import { DEMO_RUNTIME_SCRIPT, demoFake } from './demo/index.ts';
import {
  createOrchestrator,
  runAttempt,
  sparTurn,
  type OrchestratorDeps,
} from './pipeline/index.ts';
import { selectRuntime } from './sandbox/index.ts';
import { createSecrets, redactor } from './security/index.ts';
import { createStore, type Store } from './store/index.ts';
import { systemClock, type Clock } from './util/clock.ts';
import { createIdGen } from './util/id-gen.ts';

const DEFAULT_WEB_ROOT = resolve(import.meta.dirname, '../../dist/web');

export interface Running {
  /** The address actually bound (port 0 resolves to a free port). */
  address: { host: string; port: number };
  /** The live store (integration tests commit through it to drive hooks and SSE). */
  store: Store;
  /** The HTTP app (integration tests drive it through `app.request`). */
  app: Hono;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Script for the `fake` model provider; replaces the demo scripts (integration tests). */
  fakeScript?: FakeScript;
  /** Time source for the whole server (tests pass a FakeClock); defaults to the system clock. */
  clock?: Clock;
  /** Scheduler tick interval (tests shorten it). */
  schedulerTickMs?: number;
  /** Wraps each sparring turn (tests hold a turn in flight to observe shutdown). */
  wrapSparTurn?: (run: SparTurnRunner) => SparTurnRunner;
  /** Orchestrator retry policy (tests shorten or lengthen the backoff). */
  orchestratorBackoff?: OrchestratorDeps['backoff'];
  /** Wraps each orchestrator run (tests observe when runs start and end). */
  wrapRunOrchestrator?: (run: Runners['runOrchestrator']) => Runners['runOrchestrator'];
}

/** Composition root: config → data dir → DB → store → app → serve. */
export async function start(
  config: Config,
  webRoot = DEFAULT_WEB_ROOT,
  options: StartOptions = {},
): Promise<Running> {
  const clock = options.clock ?? systemClock;
  ensureDataDir(config.dataDir);
  const db = open(config.dbPath);
  // Registers every stored secret with the redactor before anything can log or emit.
  const secrets = createSecrets({ db, clock, redactor });
  const ids = createIdGen(clock);
  // inboxHook turns owner-relevant events into inbox.created in the same commit (§4.2).
  const store = createStore({ db, clock, redactor, hooks: [inboxHook({ ids })] });
  const git = createGit({ dataDir: config.dataDir });
  // settings.modelDeps() is what agent runs pass to the LLM registry (keys read at call time).
  const settings = createAccountSettings({ store, db, secrets });
  const {
    fakeScript,
    wrapSparTurn = (run) => run,
    wrapRunOrchestrator = (run) => run,
    orchestratorBackoff,
    schedulerTickMs,
  } = options;
  const logsDir = join(config.dataDir, 'logs');
  // Demo mode answers every role from its default script (src/server/demo) unless a test
  // passes one; the fake provider is only used when no real model is configured.
  const demo = config.demo ? demoFake(store) : undefined;
  const modelDeps = (): ModelDeps => {
    const deps = settings.modelDeps();
    if (fakeScript !== undefined) return { ...deps, fake: { script: fakeScript } };
    return demo === undefined ? deps : { ...deps, fake: demo };
  };
  const sparring = createSparring({
    store,
    ids,
    sparTurn: wrapSparTurn((productId, message) =>
      sparTurn(
        {
          store,
          ids,
          clock,
          redactor,
          logsDir,
          modelDeps: modelDeps(),
          demo: config.demo,
        },
        productId,
        message,
      ),
    ),
    onError: (err) => {
      console.error(redactor.redact(`sparring turn failed: ${String(err)}`));
    },
  });
  const app = createApp({ store, ids, git, redactor, webRoot, settings, sparring });
  const runtime = selectRuntime(config, config.demo ? { script: DEMO_RUNTIME_SCRIPT } : {});
  // The orchestrator merges under the scheduler's lock and the scheduler runs the orchestrator:
  // the lock closure reads `scheduler` only during a run, after it has been created below.
  const orchestrator = createOrchestrator({
    store,
    ids,
    clock,
    redactor,
    logsDir,
    git,
    runtime,
    // A getter: every run reads the settings again (provider config and keys at call time).
    get modelDeps() {
      return modelDeps();
    },
    withMergeLock: (productId, fn) => scheduler.withMergeLock(productId, fn),
    demo: config.demo,
    ...(orchestratorBackoff === undefined ? {} : { backoff: orchestratorBackoff }),
  });
  const scheduler = createScheduler({
    store,
    clock,
    ids,
    runners: {
      runOrchestrator: wrapRunOrchestrator(orchestrator.runOrchestrator),
      runAttempt: (issueId, run) =>
        runAttempt(
          {
            store,
            ids,
            clock,
            redactor,
            logsDir,
            artifactsDir: join(config.dataDir, 'artifacts'),
            git,
            runtime,
            // A getter, as for the orchestrator: keys and provider settings at call time.
            get modelDeps() {
              return modelDeps();
            },
            withMergeLock: (productId, fn) => scheduler.withMergeLock(productId, fn),
            demo: config.demo,
          },
          issueId,
          run,
        ),
    },
    ...(schedulerTickMs === undefined ? {} : { tickMs: schedulerTickMs }),
    orchestratorNotBefore: orchestrator.orchestratorNotBefore,
    onError: (err) => {
      console.error(redactor.redact(`scheduler run failed: ${String(err)}`));
    },
  });

  const { server, address } = await new Promise<{
    server: ServerType;
    address: { host: string; port: number };
  }>((done) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
      done({ server: s, address: { host: info.address, port: info.port } });
    });
  });

  scheduler.start();

  return {
    address,
    store,
    app,
    close: async () => {
      // First: live orchestrator runs see shouldStop() and settle before anything closes.
      await scheduler.stop();
      // A sparring turn commits when its agent answers: let it finish before the DB closes.
      await sparring.idle();
      await new Promise<void>((done, fail) => {
        // SSE streams never end on their own: drop open connections so close() can finish.
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close((err) => {
          db.$client.close();
          if (err) fail(err);
          else done();
        });
      });
    },
  };
}

/** The parts of `process` that graceful shutdown uses (tests pass a fake). */
export interface SignalTarget {
  once(signal: 'SIGINT' | 'SIGTERM', fn: () => void): unknown;
  exit(code: number): void;
}

/**
 * Graceful shutdown: the first SIGINT or SIGTERM closes the server once (scheduler first, see
 * `close`), then exits 0, or 1 when closing failed. Listeners are `once`, so repeating the same
 * signal gets Node's default handling and force-quits a stuck shutdown.
 */
export function closeOnSignals(
  running: Pick<Running, 'close'>,
  proc: SignalTarget = process,
  log: (line: string) => void = console.error,
): void {
  let closing = false;
  const onSignal = () => {
    if (closing) return;
    closing = true;
    running.close().then(
      () => {
        proc.exit(0);
      },
      (err: unknown) => {
        log(redactor.redact(`shutdown failed: ${String(err)}`));
        proc.exit(1);
      },
    );
  };
  proc.once('SIGINT', onSignal);
  proc.once('SIGTERM', onSignal);
}

if (import.meta.main) {
  const running = await start(parseConfig(process.env));
  closeOnSignals(running);
  const { host, port } = running.address;
  console.log(`Vibecode listening on http://${host}:${String(port)}`);
}
