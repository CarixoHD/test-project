import { describe, expect, it } from 'vitest';
import { AgentViewSchema, type AgentView } from '../../../shared/state.ts';
import { agentStateText, liveAgents, roleLabel } from './agent-model.ts';

const agent = (patch: Partial<AgentView> = {}): AgentView =>
  AgentViewSchema.parse({
    id: 'a1',
    productId: 'p1',
    role: 'implementer',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    issueId: null,
    attemptId: null,
    state: 'working',
    until: null,
    lastActivity: null,
    startedAt: 10,
    endedAt: null,
    ...patch,
  });

describe('roleLabel', () => {
  it('names each role by its worker figure and keeps the technical role', () => {
    expect(roleLabel('orchestrator')).toBe('Foreman (orchestrator)');
    expect(roleLabel('implementer')).toBe('Builder (implementer)');
    expect(roleLabel('reviewer')).toBe('Inspector (reviewer)');
    expect(roleLabel('sparring')).toBe('Drafter (sparring)');
  });
});

describe('agentStateText', () => {
  const at = (ts: number) => `T${String(ts)}`;
  it('describes each state in words', () => {
    expect(agentStateText(agent(), at)).toBe('Working');
    expect(agentStateText(agent({ state: 'waiting_owner' }), at)).toBe('Waiting for owner');
    expect(agentStateText(agent({ state: 'rate_limited', until: 99 }), at)).toBe(
      'Rate limited until T99',
    );
    expect(agentStateText(agent({ state: 'rate_limited' }), at)).toBe('Rate limited');
    expect(agentStateText(agent({ state: 'exited', endedAt: 20 }), at)).toBe('Finished');
  });
});

describe('liveAgents', () => {
  it("returns the product's running agents, oldest first", () => {
    const agents = {
      a1: agent({ id: 'a1' as AgentView['id'], startedAt: 30 }),
      a2: agent({ id: 'a2' as AgentView['id'], startedAt: 20 }),
      a3: agent({ id: 'a3' as AgentView['id'], endedAt: 40, state: 'exited' }),
      a4: agent({ id: 'a4' as AgentView['id'], productId: 'p2' as AgentView['productId'] }),
    };
    expect(liveAgents(agents, 'p1').map((a) => a.id)).toEqual(['a2', 'a1']);
  });
});
