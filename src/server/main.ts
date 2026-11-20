import { join, resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { ensureDataDir, parseConfig, type Config } from './config.ts';
import { open } from './db/index.ts';
import { createGit } from './git/index.ts';
import { createApp } from './http/index.ts';
import { inboxHook } from './notify/index.ts';
import { createScheduler, type Runners } from './scheduler/index.ts';
import { createAccountSettings, createSparring, type SparTurnRunner } from './commands/index.ts';
import type { FakeScript } from './llm/index.ts';
import { createOrchestrator, sparTurn, type OrchestratorDeps } from './pipeline/index.ts';
import { selectRuntime } from './sandbox/index.ts';
import { createSecrets, redactor } from './security/index.ts';
import { createStore, type Store } from './store/index.ts';
import { systemClock } from './util/clock.ts';
import { createIdGen } from './util/id-gen.ts';

const DEFAULT_WEB_ROOT = resolve(import.meta.dirname, '../../dist/web');

export interface Running {
  /** The address actually bound (port 0 resolves to a free port). */
  address: { host: string; port: number };
  /** The live store (integration tests commit through it to drive hooks and SSE). */
  store: Store;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Script for the `fake` model provider (integration tests; demo scripts are #31). */
  fakeScript?: FakeScript;
  /** Wraps each sparring turn (tests hold a turn in flight to observe shutdown). */
  wrapSparTurn?: (run: SparTurnRunner) => SparTurnRunner;
  /** Orchestrator retry policy (tests shorten or lengthen the backoff). */
  orchestratorBackoff?: OrchestratorDeps['backoff'];
  /** Wraps each orchestrator run (tests observe when runs start and end). */
  wrapRunOrchestrator?: (run: Runners['runOrchestrator']) => Runners['runOrchestrator'];
}

/** Placeholder until the implementer/reviewer pipeline is wired in (#28/#31): does nothing. */
const NO_OP_RUN_ATTEMPT: Runners['runAttempt'] = () => Promise.resolve();

/** Composition root: config → data dir → DB → store → app → serve. */
export async function start(
  config: Config,
  webRoot = DEFAULT_WEB_ROOT,
  options: StartOptions = {},
): Promise<Running> {
  ensureDataDir(config.dataDir);
  const db = open(config.dbPath);
  // Registers every stored secret with the redactor before anything can log or emit.
  const secrets = createSecrets({ db, clock: systemClock, redactor });
  const ids = createIdGen(systemClock);
  // inboxHook turns owner-relevant events into inbox.created in the same commit (§4.2).
  const store = createStore({ db, clock: systemClock, redactor, hooks: [inboxHook({ ids })] });
  const git = createGit({ dataDir: config.dataDir });
  // settings.modelDeps() is what agent runs pass to the LLM registry (keys read at call time).
  const settings = createAccountSettings({ store, db, secrets });
  const {
    fakeScript,
    wrapSparTurn = (run) => run,
    wrapRunOrchestrator = (run) => run,
    orchestratorBackoff,
  } = options;
  const logsDir = join(config.dataDir, 'logs');
  const modelDeps = () => ({
    ...settings.modelDeps(),
    ...(fakeScript === undefined ? {} : { fake: { script: fakeScript } }),
  });
  const sparring = createSparring({
    store,
    ids,
    sparTurn: wrapSparTurn((productId, message) =>
      sparTurn(
        {
          store,
          ids,
          clock: systemClock,
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
  const runtime = selectRuntime(config);
  // The orchestrator merges under the scheduler's lock and the scheduler runs the orchestrator:
  // the lock closure reads `scheduler` only during a run, after it has been created below.
  const orchestrator = createOrchestrator({
    store,
    ids,
    clock: systemClock,
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
    clock: systemClock,
    ids,
    runners: {
      runOrchestrator: wrapRunOrchestrator(orchestrator.runOrchestrator),
      runAttempt: NO_OP_RUN_ATTEMPT,
    },
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

if (import.meta.main) {
  const running = await start(parseConfig(process.env));
  const { host, port } = running.address;
  console.log(`Vibecode listening on http://${host}:${String(port)}`);
}
