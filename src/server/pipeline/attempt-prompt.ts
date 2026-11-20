import type { IssueState } from '../../shared/state.ts';
import type { Store } from '../store/index.ts';
import { renderPrompt } from './prompts.ts';
import { readRepoFile } from './repo-file.ts';

// Prompts of an attempt's agents (ARCHITECTURE §6 flow 4): the implementer gets the issue, the
// PRD, AGENTS.md and the previous attempt's feedback; the reviewer gets the issue, the check
// output and the diff. Everything inserted is data for prompts/implementer.md and reviewer.md.

const DIFF_LIMIT = 200_000;
const CHECK_OUTPUT_LINES = 200;
const NONE = '(none)';

export type AgentPrompt = { instructions: string; prompt: string };

/** The last `n` lines of a check log (feedback and the reviewer's view of the output). */
export function tailLines(text: string, n = CHECK_OUTPUT_LINES): string {
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.length <= n ? lines.join('\n') : lines.slice(-n).join('\n');
}

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;

/** Feedback of the latest ended attempt of the issue, if any. */
function previousFeedback(store: Store, issue: IssueState): string {
  const ended = store.q.attemptsByIssue(issue.id).filter((a) => a.status !== 'running');
  const feedback = ended.at(-1)?.feedback;
  return feedback === undefined || feedback === null || feedback === '' ? NONE : feedback;
}

export async function implementerPrompt(o: {
  store: Store;
  issue: IssueState;
  productName: string;
  worktree: string;
  checkCommand: readonly string[];
}): Promise<AgentPrompt> {
  const [prd, agentsMd] = await Promise.all([
    readRepoFile(o.worktree, 'docs/PRD.md'),
    readRepoFile(o.worktree, 'AGENTS.md'),
  ]);
  const instructions = renderPrompt('implementer', {
    productName: o.productName,
    checkCommand: o.checkCommand.join(' '),
    issueNumber: String(o.issue.number),
    issueTitle: o.issue.title,
    issueBody: o.issue.body,
    feedback: previousFeedback(o.store, o.issue),
    agentsMd: agentsMd.ok ? agentsMd.value : '(the repository has no AGENTS.md)',
    prd: prd.ok ? prd.value : '(docs/PRD.md is missing)',
  });
  return { instructions, prompt: renderPrompt('implementer-task', {}) };
}

export function reviewerPrompt(o: {
  issue: IssueState;
  productName: string;
  checkCommand: readonly string[];
  checkExit: number | null;
  checkOutput: string;
  diff: string;
}): AgentPrompt {
  const instructions = renderPrompt('reviewer', {
    productName: o.productName,
    issueNumber: String(o.issue.number),
    issueTitle: o.issue.title,
    issueBody: o.issue.body,
    checkCommand: o.checkCommand.join(' '),
    checkExit: o.checkExit === null ? 'none' : String(o.checkExit),
    checkOutput: tailLines(o.checkOutput) || NONE,
    diff: clip(o.diff, DIFF_LIMIT),
  });
  return { instructions, prompt: renderPrompt('reviewer-task', {}) };
}
