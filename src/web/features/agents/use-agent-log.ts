import { useEffect, useState } from 'react';
import { z } from 'zod';
import { recheckSession } from '../../state/api.ts';

// Follows GET /api/agents/:id/log?follow=1 (ARCHITECTURE §4.3): one unnamed SSE message per
// `{ts, line}`, existing lines first, then `event: end` once the agent has exited.

/** Lines kept in memory; older ones drop off the top of a very long log. */
export const MAX_LOG_LINES = 5_000;

const LogLineSchema = z.object({ ts: z.number(), line: z.string() });
export type LogLine = z.infer<typeof LogLineSchema>;

export type LogStatus = 'connecting' | 'live' | 'ended' | 'lost';

export interface AgentLog {
  lines: LogLine[];
  status: LogStatus;
}

const EMPTY: AgentLog = { lines: [], status: 'connecting' };

/** The agent's log; the stream closes on unmount, on another agent id, or at its end. */
export function useAgentLog(agentId: string): AgentLog {
  // Tagged with its agent: switching agents shows nothing until the new stream delivers.
  const [log, setTagged] = useState<AgentLog & { agentId: string }>({ ...EMPTY, agentId });

  useEffect(() => {
    const setLog = (next: AgentLog | ((prev: AgentLog) => AgentLog)) =>
      setTagged((prev) => {
        const base = prev.agentId === agentId ? prev : EMPTY;
        return { ...(typeof next === 'function' ? next(base) : next), agentId };
      });
    const source = new EventSource(`/api/agents/${encodeURIComponent(agentId)}/log?follow=1`);
    // Every (re)connect resends the whole log, so start over instead of duplicating lines.
    source.onopen = () => setLog({ lines: [], status: 'live' });
    source.onmessage = (ev: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      const line = LogLineSchema.safeParse(parsed);
      if (!line.success) return;
      setLog((prev) => ({
        status: prev.status === 'connecting' ? 'live' : prev.status,
        lines: [...prev.lines, line.data].slice(-MAX_LOG_LINES),
      }));
    };
    const onEnd = () => {
      source.close();
      setLog((prev) => ({ ...prev, status: 'ended' }));
    };
    source.addEventListener('end', onEnd);
    let unmounted = false;
    let checking = false;
    // EventSource cannot read a 401: ask GET /api/session whether the session is gone (that
    // shows Login via onUnauthorized) instead of letting the browser retry forever.
    const checkSession = async () => {
      if (checking) return;
      checking = true;
      const session = await recheckSession();
      checking = false;
      if (unmounted || session !== 'unauthenticated') return;
      source.close();
      setLog((prev) => ({ ...prev, status: 'lost' }));
    };
    // The browser retries on its own; only a closed source (e.g. 404) is final.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setLog((prev) => ({ ...prev, status: 'lost' }));
      void checkSession();
    };
    return () => {
      unmounted = true;
      source.removeEventListener('end', onEnd);
      source.close();
    };
  }, [agentId]);

  return log.agentId === agentId ? { lines: log.lines, status: log.status } : EMPTY;
}
