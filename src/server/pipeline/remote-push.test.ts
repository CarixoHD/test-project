import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventDraft } from '../../shared/events.ts';
import { updateProductSettings } from '../commands/index.ts';
import { GitError, type Git, type PushRemote } from '../git/index.ts';
import { gitTokenSecret, Redactor } from '../security/index.ts';
import { expectSnapshotMatchesReplay } from '../store/testing.ts';
import { P, setupAttempt, type Harness } from './attempt-testing.ts';
import { startRemotePusher, type RemotePusher } from './remote-push.ts';

// The optional push of main after merges (PRD 'Code location', ARCHITECTURE §6 flow 4 step 7):
// a store subscriber that pushes asynchronously, outside the merge lock, and reports failures
// to the inbox without failing the issue.

const TOKEN = 'ghp_RemotePushToken1234567890';
const URL = 'https://github.com/owner/todo.git';

let dataDir: string;
let h: Harness;
let pusher: RemotePusher | undefined;
let pushes: { productId: string; remote: PushRemote; mainSha: string }[];
let pushImpl: (remote: PushRemote) => Promise<void>;
const secrets = new Map<string, string>();

beforeEach(async () => {
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'vibecode-remote-push-')));
  h = await setupAttempt(dataDir);
  pushes = [];
  pushImpl = () => Promise.resolve();
  secrets.clear();
});
afterEach(async () => {
  pusher?.stop();
  pusher = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

function start(redactor = new Redactor()): RemotePusher {
  const git: Pick<Git, 'push'> = {
    push: async (productId, remote) => {
      pushes.push({ productId, remote, mainSha: await h.git.mainSha(P) });
      await pushImpl(remote);
    },
  };
  pusher = startRemotePusher({
    store: h.store,
    ids: h.ids,
    git,
    secrets: { get: (key) => secrets.get(key) },
    redactor,
  });
  return pusher;
}

function setRemote(url: string): void {
  const r = updateProductSettings({ store: h.store, ids: h.ids }, P, { gitRemote: { url } });
  if (!r.ok) throw new Error(r.reason);
}

const inboxErrors = () =>
  Object.values(h.store.snapshot().state.inbox).filter((i) => i.kind === 'error');

describe('remote push after merges', () => {
  it('pushes main with the stored token after each merged issue', async () => {
    setRemote(URL);
    secrets.set(gitTokenSecret(P), TOKEN);
    const p = start();

    await h.run(h.addIssue('Scaffold'));
    await p.idle();
    expect(pushes).toEqual([
      { productId: P, remote: { url: URL, token: TOKEN }, mainSha: await h.git.mainSha(P) },
    ]);

    await h.run(h.addIssue('Login'));
    await p.idle();
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.mainSha).toBe(await h.git.mainSha(P));
    expect(inboxErrors()).toEqual([]);
  });

  it('pushes without a token when none is stored', async () => {
    setRemote(URL);
    const p = start();
    await h.run(h.addIssue('Scaffold'));
    await p.idle();
    expect(pushes.map((x) => x.remote)).toEqual([{ url: URL, token: null }]);
  });

  it('does nothing when no remote is configured', async () => {
    const p = start();
    await h.run(h.addIssue('Scaffold'));
    await p.idle();
    expect(pushes).toEqual([]);
  });

  it('pushes after a PRD commit (prd.applied)', async () => {
    setRemote(URL);
    const p = start();
    h.store.commit(() => [
      {
        type: 'prd.applied',
        productId: P,
        entityId: null,
        v: 1,
        data: { version: 1, markdown: '# PRD\n', summary: null },
      } as EventDraft,
    ]);
    await p.idle();
    expect(pushes).toHaveLength(1);
  });

  it('pushes once a remote is configured, so main reaches it without waiting for a merge', async () => {
    const p = start();
    setRemote(URL);
    await p.idle();
    expect(pushes).toHaveLength(1);
  });

  it('a failed push posts an inbox error but leaves the issue completed', async () => {
    setRemote(URL);
    secrets.set(gitTokenSecret(P), TOKEN);
    const redactor = new Redactor();
    redactor.register(TOKEN);
    pushImpl = () =>
      Promise.reject(new GitError(`fatal: Authentication failed (token ${TOKEN})`));
    const p = start(redactor);
    const id = h.addIssue('Scaffold');

    await h.run(id);
    await p.idle();

    expect(h.store.q.issue(id)?.status).toBe('completed');
    const errors = inboxErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.title).toBe('Push to the git remote failed');
    expect(errors[0]?.body).toContain('Authentication failed');
    expect(errors[0]?.body).toContain('Settings');
    expect(errors[0]?.link).toBe(`/products/${P}/settings`);
    // The token is in no event, inbox item or snapshot.
    expect(JSON.stringify(h.store.eventsSince(0))).not.toContain(TOKEN);
    expect(JSON.stringify(h.store.snapshot())).not.toContain(TOKEN);
    expectSnapshotMatchesReplay(h.store);
  });

  it('repeats an identical failure only after a push succeeded in between', async () => {
    setRemote(URL);
    let fail = true;
    pushImpl = () => (fail ? Promise.reject(new GitError('remote unreachable')) : Promise.resolve());
    const p = start();
    const push = async () => {
      p.request(P);
      await p.idle();
    };

    await push();
    await push();
    expect(inboxErrors()).toHaveLength(1);

    fail = false;
    await push();
    fail = true;
    await push();
    expect(inboxErrors()).toHaveLength(2);
    expect(pushes).toHaveLength(4);
  });

  it('re-validates the stored URL: an invalid one never reaches git and posts an inbox error', async () => {
    // Stored before the URL rule existed (#97): the stored schema still accepts it.
    h.store.commit(() => [
      {
        type: 'product.settings_changed',
        productId: P,
        entityId: null,
        v: 1,
        data: { gitRemote: { url: 'ext::sh -c touch% /tmp/pwned' } },
      } as EventDraft,
    ]);
    const p = start();
    const id = h.addIssue('Scaffold');

    await h.run(id);
    await p.idle();

    expect(pushes).toEqual([]);
    expect(h.store.q.issue(id)?.status).toBe('completed');
    const errors = inboxErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.title).toBe('Git remote URL is not allowed');
    expect(errors[0]?.body).toContain('Settings');
    expect(errors[0]?.body).not.toContain('ext::');
  });

  it('coalesces requests that arrive while a push runs into one follow-up push', async () => {
    setRemote(URL);
    const releases: (() => void)[] = [];
    pushImpl = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    const p = start();
    p.request(P);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    p.request(P);
    p.request(P);
    p.request(P);
    releases[0]?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]?.();
    await p.idle();
    expect(pushes).toHaveLength(2);
  });

  it('stops pushing after stop()', async () => {
    setRemote(URL);
    const p = start();
    p.stop();
    await h.run(h.addIssue('Scaffold'));
    await p.idle();
    expect(pushes).toEqual([]);
  });
});
