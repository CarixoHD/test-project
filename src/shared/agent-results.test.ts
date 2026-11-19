import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ImplResultSchema,
  IssueOpSchema,
  PlanResultSchema,
  ProjectConfigSchema,
  ReviewResultSchema,
  SparResultSchema,
} from './agent-results.ts';

type Case = [name: string, sample: unknown];

const PROJECT = {
  check: ['npm', 'test'],
  imageInputs: ['package-lock.json'],
  preview: { command: ['npm', 'start'], port: 3000 },
};

const SCHEMAS: {
  name: string;
  schema: z.ZodType;
  valid: Case[];
  invalid: Case[];
}[] = [
  {
    name: 'SparResult',
    schema: SparResultSchema,
    valid: [
      ['reply only', { reply: 'What should it do?' }],
      ['reply with PRD', { reply: 'Draft updated.', prdMarkdown: '# PRD' }],
    ],
    invalid: [
      ['missing reply', { prdMarkdown: '# PRD' }],
      ['empty reply', { reply: '' }],
      ['non-string PRD', { reply: 'ok', prdMarkdown: 42 }],
    ],
  },
  {
    name: 'IssueOp',
    schema: IssueOpSchema,
    valid: [
      ['create', { op: 'create', key: 'a', title: 'T', body: 'B', dependsOn: [] }],
      [
        'create with deps and priority',
        { op: 'create', key: 'b', title: 'T', body: 'B', dependsOn: ['a', '01J'], priority: 2 },
      ],
      ['edit title only', { op: 'edit', id: '01J', title: 'New' }],
      ['edit deps', { op: 'edit', id: '01J', dependsOn: ['01K'] }],
      ['cancel', { op: 'cancel', id: '01J', reason: 'obsolete' }],
      ['rewrite', { op: 'rewrite', id: '01J', body: 'Smaller scope' }],
    ],
    invalid: [
      ['unknown op', { op: 'delete', id: '01J' }],
      ['create without key', { op: 'create', title: 'T', body: 'B', dependsOn: [] }],
      ['create without dependsOn', { op: 'create', key: 'a', title: 'T', body: 'B' }],
      [
        'create with fractional priority',
        { op: 'create', key: 'a', title: 'T', body: 'B', dependsOn: [], priority: 1.5 },
      ],
      ['edit without id', { op: 'edit', title: 'T' }],
      ['cancel without reason', { op: 'cancel', id: '01J' }],
      ['rewrite without body', { op: 'rewrite', id: '01J' }],
    ],
  },
  {
    name: 'PlanResult',
    schema: PlanResultSchema,
    valid: [
      ['empty plan', { issueOps: [], questions: [], summary: 'Nothing to do' }],
      [
        'plan with ops and project',
        {
          issueOps: [{ op: 'create', key: 'a', title: 'T', body: 'B', dependsOn: [] }],
          questions: ['Which database?'],
          summary: 'Planned 1 issue',
          project: PROJECT,
        },
      ],
    ],
    invalid: [
      ['missing summary', { issueOps: [], questions: [] }],
      ['bad op inside', { issueOps: [{ op: 'nope' }], questions: [], summary: 's' }],
      ['questions not strings', { issueOps: [], questions: [1], summary: 's' }],
      ['bad project', { issueOps: [], questions: [], summary: 's', project: { check: [] } }],
    ],
  },
  {
    name: 'ImplResult',
    schema: ImplResultSchema,
    valid: [
      ['summary', { summary: 'Added the endpoint' }],
      ['with question', { summary: 'Blocked', question: 'Which auth provider?' }],
    ],
    invalid: [
      ['missing summary', { question: 'Q?' }],
      ['empty question', { summary: 's', question: '' }],
    ],
  },
  {
    name: 'ReviewResult',
    schema: ReviewResultSchema,
    valid: [
      ['approve', { approve: true, findings: [] }],
      ['reject', { approve: false, findings: ['Missing test for empty input'] }],
    ],
    invalid: [
      ['approve as string', { approve: 'yes', findings: [] }],
      ['missing findings', { approve: true }],
    ],
  },
  {
    name: 'ProjectConfig',
    schema: ProjectConfigSchema,
    valid: [
      ['full', PROJECT],
      ['no preview', { check: ['make', 'test'], imageInputs: [] }],
      ['nested lockfile', { check: ['pytest'], imageInputs: ['backend/uv.lock'] }],
    ],
    invalid: [
      ['empty check', { check: [], imageInputs: [] }],
      ['check as shell string', { check: 'npm test', imageInputs: [] }],
      ['empty argv element', { check: [''], imageInputs: [] }],
      ['absolute image input', { check: ['x'], imageInputs: ['/etc/passwd'] }],
      ['escaping image input', { check: ['x'], imageInputs: ['../secrets'] }],
      ['nested escaping image input', { check: ['x'], imageInputs: ['a/../../b'] }],
      ['backslash image input', { check: ['x'], imageInputs: ['..\\b'] }],
      [
        'empty preview command',
        { check: ['x'], imageInputs: [], preview: { command: [], port: 1 } },
      ],
      ['port 0', { check: ['x'], imageInputs: [], preview: { command: ['x'], port: 0 } }],
      ['port too big', { check: ['x'], imageInputs: [], preview: { command: ['x'], port: 70000 } }],
    ],
  },
];

describe.each(SCHEMAS)('$name', ({ schema, valid, invalid }) => {
  it.each(valid)('accepts %s', (_name, sample) => {
    expect(schema.safeParse(sample).success).toBe(true);
  });

  it.each(invalid)('rejects %s', (_name, sample) => {
    expect(schema.safeParse(sample).success).toBe(false);
  });

  it('converts to JSON Schema for the finish tool / --json-schema', () => {
    expect(() => z.toJSONSchema(schema)).not.toThrow();
  });
});
