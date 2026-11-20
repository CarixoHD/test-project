import type { EventOf } from '../../shared/events.ts';
import type { FakeModelOptions, FakeScript } from '../llm/index.ts';
import type { FakeRunRule } from '../sandbox/index.ts';
import type { Store } from '../store/index.ts';

// Demo mode (VIBECODE_DEMO=1, ARCHITECTURE §7): default scripts for the `fake` provider, one per
// role, and the FakeContainerRuntime rule that answers the demo check. No keys, no Docker.

/** The check the demo orchestrator writes into `.vibecode/project.json`. */
export const DEMO_CHECK = ['test', '-f', 'docs/PRD.md'] as const;

/** Answers the demo check with exit 0 inside FakeContainerRuntime. */
export const DEMO_RUNTIME_SCRIPT: readonly FakeRunRule[] = [
  { match: DEMO_CHECK, result: { code: 0, stdout: 'demo check passed\n' } },
];

export const DEMO_QUESTIONS = [
  'Who will use it, and what do they need most?',
  'What is the one thing the first version must do well?',
] as const;

const finish = (input: object) => ({ toolCalls: [{ name: 'finish', input }] });

/**
 * Sparring: asks the two questions in turn, then answers with a full PRD draft from then on.
 * `agentReplies` counts the agent messages the product already has.
 */
export function sparringScript(agentReplies: number): FakeScript {
  const question = DEMO_QUESTIONS[agentReplies];
  if (question !== undefined) return [finish({ reply: question })];
  return [
    finish({
      reply: 'Thanks, I have enough for a first version. The PRD draft is in the Spec tab.',
      prdMarkdown: [
        '# {{product.name}}',
        '',
        '## Idea',
        '{{product.idea}}',
        '',
        '## Scope',
        '- Scaffold the project.',
        '- Build the core feature.',
        '- Polish the experience.',
        '',
      ].join('\n'),
    }),
  ];
}

const PROJECT_JSON = `${JSON.stringify({ check: DEMO_CHECK, imageInputs: [] }, null, 2)}\n`;

/** Orchestrator: writes `.vibecode/project.json`, then plans three chained issues. */
export const ORCHESTRATOR_SCRIPT: FakeScript = [
  {
    toolCalls: [
      { name: 'write_file', input: { path: '.vibecode/project.json', content: PROJECT_JSON } },
    ],
  },
  finish({
    issueOps: [
      {
        op: 'create',
        key: 'scaffold',
        title: 'Scaffold',
        body: 'Set up the project skeleton.',
        dependsOn: [],
      },
      {
        op: 'create',
        key: 'core',
        title: 'Core feature',
        body: 'Build the main feature on top of the scaffold.',
        dependsOn: ['scaffold'],
      },
      {
        op: 'create',
        key: 'polish',
        title: 'Polish',
        body: 'Polish the core feature.',
        dependsOn: ['core'],
      },
    ],
    questions: [],
    summary: 'Three slices: scaffold, core feature, polish.',
  }),
];

/** Implementer: writes one file named after its issue, then reports. */
export const IMPLEMENTER_SCRIPT: FakeScript = [
  {
    toolCalls: [
      {
        name: 'write_file',
        input: {
          path: 'src/issue-{{issue.number}}.md',
          content: '# #{{issue.number}} {{issue.title}}\n\nDone in demo mode.\n',
        },
      },
    ],
  },
  finish({ summary: 'Implemented #{{issue.number}} {{issue.title}}.' }),
];

export const REVIEWER_SCRIPT: FakeScript = [finish({ approve: true, findings: [] })];

type DemoFake = { script: FakeScript; vars: NonNullable<FakeModelOptions['vars']> };

/** The script (and template vars) for the agent `spawned` announced. */
export function demoScriptFor(store: Store, spawned: EventOf<'agent.spawned'>): DemoFake {
  const product = store.q.product(spawned.productId);
  const productVars = { name: product?.name ?? 'Demo', idea: product?.idea ?? '' };
  switch (spawned.data.role) {
    case 'sparring': {
      const replies = store.q
        .sparMessages(spawned.productId)
        .filter((m) => m.role === 'agent').length;
      return { script: sparringScript(replies), vars: { product: productVars } };
    }
    case 'orchestrator':
      return { script: ORCHESTRATOR_SCRIPT, vars: {} };
    case 'implementer': {
      const { issueId } = spawned.data;
      const issue = issueId === null ? null : store.q.issue(issueId);
      return {
        script: IMPLEMENTER_SCRIPT,
        vars: { issue: { number: issue?.number ?? 0, title: issue?.title ?? '' } },
      };
    }
    case 'reviewer':
      return { script: REVIEWER_SCRIPT, vars: {} };
    case 'utility':
      // No demo behaviour: an empty script fails the run with "Fake script exhausted".
      return { script: [], vars: {} };
  }
}

/**
 * ModelDeps.fake for demo mode. Callers spread ModelDeps before an agent is spawned, so this
 * object is passed along unchanged and its getters are read only when the registry builds the
 * model: synchronously right after `agent.spawned` is committed. The latest spawned agent is
 * therefore the one asking, and its role picks the script.
 */
export function demoFake(store: Store): DemoFake {
  let seq = 0;
  let spawned: EventOf<'agent.spawned'> | undefined;
  const current = (): DemoFake => {
    for (const e of store.eventsSince(seq)) {
      seq = e.seq;
      if (e.type === 'agent.spawned') spawned = e;
    }
    if (spawned === undefined) throw new Error('demo fake model: no agent has been spawned');
    return demoScriptFor(store, spawned);
  };
  return {
    get script() {
      return current().script;
    },
    get vars() {
      return current().vars;
    },
  };
}
