import type { Role } from '../../../shared/models.ts';
import type { AgentView } from '../../../shared/state.ts';

// Words for agents, shared by the agent list, the agent panel and the 3D view, so every place
// names a worker the same way (PRD: foreman, builder, inspector, drafter).

export const ROLE_FIGURE = {
  orchestrator: 'Foreman',
  implementer: 'Builder',
  reviewer: 'Inspector',
  sparring: 'Drafter',
} as const satisfies Record<Role, string>;

/** "Builder (implementer)": the worker figure's name plus the technical role. */
export function roleLabel(role: Role): string {
  return `${ROLE_FIGURE[role]} (${role})`;
}

export const formatClock = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** What the agent is doing, in words; `at` formats the rate-limit end time. */
export function agentStateText(agent: AgentView, at: (ts: number) => string = formatClock): string {
  switch (agent.state) {
    case 'working':
      return 'Working';
    case 'waiting_owner':
      return 'Waiting for owner';
    case 'rate_limited':
      return agent.until === null ? 'Rate limited' : `Rate limited until ${at(agent.until)}`;
    case 'exited':
      return 'Finished';
  }
}

/** The product's agents that have not exited, oldest first. */
export function liveAgents(agents: Record<string, AgentView>, productId: string): AgentView[] {
  return Object.values(agents)
    .filter((a) => a.productId === productId && a.endedAt === null)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}
