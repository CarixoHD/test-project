import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { AgentView, IssueState } from '../../../shared/state.ts';
import { Button, Dialog } from '../../ui/index.ts';
import { agentStateText, roleLabel } from './agent-model.ts';
import { useAgentLog, type LogStatus } from './use-agent-log.ts';

/** Distance from the bottom (px) that still counts as "at the end" of the log. */
const STICK_SLACK_PX = 4;

export interface AgentPanelProps {
  agent: AgentView;
  /** The agent's current issue, when it works on one. */
  issue?: IssueState | null | undefined;
  open: boolean;
  onClose: () => void;
}

const STATUS_TEXT: Record<LogStatus, string | null> = {
  connecting: 'Connecting to the log…',
  live: null,
  ended: 'The agent has finished; this is its full log.',
  lost: 'The log stream was lost. Close and reopen the panel to try again.',
};

/**
 * One agent in a dialog: role, provider/model, current issue, state and its live log.
 * Reused by the agent list and the 3D view (click on a worker figure).
 */
export function AgentPanel({ agent, issue, open, onClose }: AgentPanelProps) {
  return (
    <Dialog open={open} onClose={onClose} title={roleLabel(agent.role)}>
      <dl className="agent-facts">
        <dt>Model</dt>
        <dd>
          {agent.provider} / {agent.model}
        </dd>
        <dt>Issue</dt>
        <dd>
          <IssueLink issue={issue} />
        </dd>
        <dt>State</dt>
        <dd>{agentStateText(agent)}</dd>
      </dl>
      <LiveLog agentId={agent.id} />
    </Dialog>
  );
}

/** "#3 Login form" linking to the issue, or "No issue". */
export function IssueLink({ issue }: { issue?: IssueState | null | undefined }) {
  if (issue === undefined || issue === null) return <>No issue</>;
  return (
    <Link to={`/products/${issue.productId}/issues/${issue.id}`}>
      #{issue.number} {issue.title}
    </Link>
  );
}

export interface LiveLogProps {
  agentId: string;
  /** Accessible name of the log region. */
  label?: string;
}

/**
 * Plain-text log that follows new lines unless the owner has scrolled up. Used by the panel
 * and by the issue detail page (each attempt's agent logs).
 */
export function LiveLog({ agentId, label = 'Live log' }: LiveLogProps) {
  const { lines, status } = useAgentLog(agentId);
  const boxRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  const scrollToEnd = () => {
    const box = boxRef.current;
    if (box !== null) box.scrollTop = box.scrollHeight - box.clientHeight;
  };

  useLayoutEffect(() => {
    if (follow) scrollToEnd();
  }, [lines, follow]);

  const onScroll = () => {
    const box = boxRef.current;
    if (box === null) return;
    setFollow(box.scrollHeight - box.scrollTop - box.clientHeight <= STICK_SLACK_PX);
  };

  const note = STATUS_TEXT[status];
  return (
    <div className="agent-log">
      {/* aria-live off: a streaming log would drown out everything else; it can be read on demand. */}
      <div
        ref={boxRef}
        className="agent-log__lines"
        role="log"
        aria-label={label}
        aria-live="off"
        // Keyboard users scroll the log with the arrow keys once it has focus.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        onScroll={onScroll}
      >
        {lines.map((l, i) => (
          <div key={i} className="agent-log__line">
            {l.line}
          </div>
        ))}
      </div>
      <div className="agent-log__footer">
        {note !== null && <p className="agent-log__note">{note}</p>}
        {!follow && (
          <>
            <p className="agent-log__note">Auto-scroll paused</p>
            <Button
              onClick={() => {
                scrollToEnd();
                setFollow(true);
              }}
            >
              Jump to latest
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
