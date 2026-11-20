import { useId, useMemo, useState } from 'react';
import type { AgentId, IssueId } from '../../../shared/ids.ts';
import type { ProductState } from '../../../shared/state.ts';
import { useApp, type AppSnapshot } from '../../state/store.ts';
import { Button } from '../../ui/index.ts';
import { agentStateText, liveAgents, roleLabel } from './agent-model.ts';
import { AgentPanel, IssueLink } from './AgentPanel.tsx';

const selectAgents = (s: AppSnapshot) => s.state.agents;
const selectIssues = (s: AppSnapshot) => s.state.issues;

/**
 * The product's running agents in words (PRD accessibility: everything the 3D view shows):
 * role, model, state, current issue and last activity line; each opens the agent panel.
 */
export function AgentList({ product }: { product: ProductState }) {
  const agents = useApp(selectAgents);
  const issues = useApp(selectIssues);
  const live = useMemo(() => liveAgents(agents, product.id), [agents, product.id]);
  const headingId = useId();
  const [openId, setOpenId] = useState<AgentId | null>(null);
  // Looked up among all agents so the panel stays open (with its full log) after an exit.
  const openAgent = openId === null ? undefined : agents[openId];
  const issueOf = (id: IssueId | null) => (id === null ? null : issues[id]);

  return (
    <section className="build-tab__slot agent-list" aria-labelledby={headingId}>
      <h2 id={headingId} className="agent-list__heading">
        Agents
      </h2>
      {live.length === 0 ? (
        <p>No agents are running.</p>
      ) : (
        <ul className="agent-list__items" aria-label="Running agents">
          {live.map((agent) => {
            const label = roleLabel(agent.role);
            const issue = issueOf(agent.issueId);
            const on = issue == null ? '' : ` on #${String(issue.number)}`;
            return (
              <li key={agent.id} className="agent-card">
                <h3 className="agent-card__role">{label}</h3>
                <dl className="agent-facts">
                  <dt>Model</dt>
                  <dd>
                    {agent.provider} / {agent.model}
                  </dd>
                  <dt>State</dt>
                  <dd>{agentStateText(agent)}</dd>
                  <dt>Issue</dt>
                  <dd>
                    <IssueLink issue={issue} />
                  </dd>
                  <dt>Last activity</dt>
                  <dd className="agent-card__activity">{agent.lastActivity ?? 'None yet'}</dd>
                </dl>
                <Button
                  aria-label={`Show log of ${label}${on}`}
                  onClick={() => setOpenId(agent.id)}
                >
                  Show log
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {openAgent !== undefined && (
        <AgentPanel
          agent={openAgent}
          issue={issueOf(openAgent.issueId)}
          open
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  );
}
