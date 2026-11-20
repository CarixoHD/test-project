import { describe, expect, it } from 'vitest';
import type { EventDraft } from '../../shared/events.ts';
import { AgentIdSchema, ProductIdSchema } from '../../shared/ids.ts';
import type { Role } from '../../shared/models.ts';
import { addIssue } from '../commands/index.ts';
import { open } from '../db/index.ts';
import { Redactor } from '../security/index.ts';
import { createStore } from '../store/index.ts';
import { FakeClock } from '../util/clock.ts';
import { FakeIdGen } from '../util/id-gen.ts';
import {
  DEMO_QUESTIONS,
  IMPLEMENTER_SCRIPT,
  ORCHESTRATOR_SCRIPT,
  REVIEWER_SCRIPT,
  demoFake,
  sparringScript,
} from './index.ts';

const P = ProductIdSchema.parse('product-1');

function setup() {
  const store = createStore({
    db: open(':memory:'),
    clock: new FakeClock(),
    redactor: new Redactor(),
  });
  const ids = new FakeIdGen();
  store.commit(() => [
    {
      type: 'product.created',
      productId: P,
      entityId: null,
      v: 1,
      data: {
        name: 'Todo',
        idea: 'todos',
        budgetUsd: null,
        maxParallel: 1,
        maxAttempts: 1,
        models: {},
        gitRemote: null,
      },
    },
  ]);
  let n = 0;
  const spawn = (role: Role, issueId: string | null = null) => {
    n += 1;
    store.commit(() => [
      {
        type: 'agent.spawned',
        productId: P,
        entityId: AgentIdSchema.parse(`agent-${String(n)}`),
        v: 1,
        data: { role, model: { provider: 'fake', model: 'fake' }, issueId, attemptId: null },
      } as EventDraft,
    ]);
  };
  return { store, ids, spawn };
}

describe('sparringScript', () => {
  it('asks the two demo questions, then returns a PRD draft', () => {
    const finishInput = (n: number) => sparringScript(n)[0]?.toolCalls?.[0]?.input;
    expect(finishInput(0)).toEqual({ reply: DEMO_QUESTIONS[0] });
    expect(finishInput(1)).toEqual({ reply: DEMO_QUESTIONS[1] });
    for (const n of [2, 5]) {
      expect(finishInput(n)).toMatchObject({ prdMarkdown: expect.stringContaining('# ') });
    }
  });
});

describe('demoFake', () => {
  it('refuses before any agent has been spawned', () => {
    const { store } = setup();
    expect(() => demoFake(store).script).toThrow(/no agent has been spawned/);
  });

  it('answers with the script of the latest spawned agent, read when accessed', () => {
    const { store, ids, spawn } = setup();
    const added = addIssue({ store, ids }, P, { title: 'Scaffold', body: 'b', dependsOn: [] });
    if (!added.ok) throw new Error(added.reason);
    const fake = demoFake(store);
    // Callers spread ModelDeps before spawning: the object must stay live.
    const copied = { ...{ fake } }.fake;

    spawn('sparring');
    expect(copied.script).toEqual(sparringScript(0));
    expect(copied.vars).toEqual({ product: { name: 'Todo', idea: 'todos' } });

    spawn('orchestrator');
    expect(copied.script).toBe(ORCHESTRATOR_SCRIPT);

    spawn('implementer', added.issueId);
    expect(copied.script).toBe(IMPLEMENTER_SCRIPT);
    expect(copied.vars).toEqual({ issue: { number: 1, title: 'Scaffold' } });

    spawn('reviewer', added.issueId);
    expect(copied.script).toBe(REVIEWER_SCRIPT);
  });
});
