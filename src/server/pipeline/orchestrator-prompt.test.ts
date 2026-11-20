import { describe, expect, it } from 'vitest';
import type { EventDraft } from '../../shared/events.ts';
import { ProductIdSchema, type ProductId } from '../../shared/ids.ts';
import { pendingTriggers } from '../../shared/triggers.ts';
import { addIssue, cancelIssue } from '../commands/index.ts';
import { open } from '../db/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import { orchestratorPrompt } from './orchestrator-prompt.ts';

const P = ProductIdSchema.parse('product-1');

const draft = (type: string, productId: ProductId, data: object) =>
  ({ type, productId, entityId: null, v: 1, data }) as EventDraft;

function setup() {
  const store = createStore({
    db: open(':memory:'),
    clock: new FakeClock(),
    redactor: new Redactor(),
  });
  const ids = new FakeIdGen();
  store.commit(() => [
    draft('product.created', P, {
      name: 'Todo',
      idea: 'todos',
      budgetUsd: null,
      maxParallel: 3,
      maxAttempts: 2,
      models: {},
      gitRemote: null,
    }),
    draft('prd.applied', P, { version: 1, markdown: '# v1', summary: null }),
    draft('product.handed_off', P, { prdVersion: 1 }),
  ]);
  return { store, ids };
}

function add(ctx: ReturnType<typeof setup>, title: string, dependsOn: string[] = []) {
  const r = addIssue(ctx, P, { title, body: '', dependsOn });
  if (!r.ok) throw new Error(r.reason);
  return r.issueId;
}

describe('orchestratorPrompt triggers', () => {
  it('describes an owner cancellation that stranded dependents', () => {
    const ctx = setup();
    const a = add(ctx, 'Scaffold');
    add(ctx, 'List todos', [a]);
    const before = ctx.store.snapshot().lastSeq;
    expect(cancelIssue(ctx, a).ok).toBe(true);
    const triggers = pendingTriggers(ctx.store.eventsSince(before), before, { productId: P });
    expect(triggers.map((e) => e.type)).toEqual(['issue.cancelled']);

    const { instructions } = orchestratorPrompt({
      store: ctx.store,
      productId: P,
      triggers,
      prd: '# v1',
      webSearch: false,
    });
    expect(instructions).toMatch(
      /The owner cancelled issue #1 Scaffold; #2 List todos depend(s)? on it and can never start/,
    );
    expect(instructions).toMatch(/#2 List todos .*depends on cancelled #1/);
  });
});
