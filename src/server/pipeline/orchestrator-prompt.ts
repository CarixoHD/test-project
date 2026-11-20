import type { Event } from '../../shared/events.ts';
import type { ProductId } from '../../shared/ids.ts';
import type { IssueState, QuestionState } from '../../shared/state.ts';
import type { Store } from '../store/index.ts';
import { renderPrompt } from './prompts.ts';

// Builds the orchestrator's prompt (ARCHITECTURE §6 flow 3) from the store: every issue with its
// status and latest attempt feedback, issues stuck behind cancelled dependencies, and the triggers
// that woke the orchestrator. All of it is data for prompts/orchestrator.md.

const FEEDBACK_LIMIT = 2_000;

const RESEARCH_AVAILABLE =
  'Web search is available. Use it to check current versions, APIs and best practices before you ' +
  'pick libraries or write the Dockerfile. Keep searches focused; each one is billed.';
const RESEARCH_UNAVAILABLE =
  'Web search is NOT available for this model. Rely on your own knowledge and prefer well-known, ' +
  'stable versions of tools and libraries.';

export type OrchestratorPromptInput = {
  store: Store;
  productId: ProductId;
  triggers: readonly Event[];
  /** Content of docs/PRD.md in the worktree, or null when it is missing. */
  prd: string | null;
  webSearch: boolean;
};

export function orchestratorPrompt(input: OrchestratorPromptInput): {
  instructions: string;
  prompt: string;
} {
  const { store, productId } = input;
  const product = store.q.product(productId);
  if (product === null) throw new Error(`Unknown product ${productId}`);
  const issues = store.q.issuesByProduct(productId);
  const { questions } = store.snapshot().state;
  const instructions = renderPrompt('orchestrator', {
    productName: product.name,
    research: input.webSearch ? RESEARCH_AVAILABLE : RESEARCH_UNAVAILABLE,
    prd: input.prd ?? '(docs/PRD.md is missing)',
    issues:
      issues.length === 0 ? '(none yet)' : issues.map((i) => describeIssue(store, i)).join('\n'),
    blockedIssues: describeBlocked(issues),
    triggers: input.triggers.map((e) => describeTrigger(e, issues, questions)).join('\n'),
    prdChange: describePrdChange(store, productId, input.triggers),
  });
  return { instructions, prompt: renderPrompt('orchestrator-task', {}) };
}

function clip(text: string): string {
  return text.length <= FEEDBACK_LIMIT ? text : `${text.slice(0, FEEDBACK_LIMIT)}…`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

function describeIssue(store: Store, issue: IssueState): string {
  const deps = issue.dependsOn.length === 0 ? 'none' : issue.dependsOn.join(', ');
  const lines = [
    `- #${String(issue.number)} [${issue.status}] ${issue.title} (id ${issue.id}, ` +
      `attempts ${String(issue.attemptCount)}, depends on: ${deps})`,
    indent(clip(issue.body)),
  ];
  if (issue.failureReason !== null) lines.push(indent(`Failure: ${clip(issue.failureReason)}`));
  const feedback = store.q
    .attemptsByIssue(issue.id)
    .filter((a) => a.feedback !== null)
    .at(-1)?.feedback;
  if (feedback != null) lines.push(indent(`Last attempt feedback: ${clip(feedback)}`));
  return lines.join('\n');
}

/**
 * The replan section for consumed `prd.applied` triggers with version > 1: the version before the
 * first of them and the newest one, so several applies in one run read as one change.
 */
function describePrdChange(store: Store, productId: ProductId, triggers: readonly Event[]): string {
  const applied = triggers.flatMap((e) =>
    e.type === 'prd.applied' && e.data.version > 1 ? [e.data] : [],
  );
  const newest = applied.reduce<(typeof applied)[number] | undefined>(
    (a, b) => (a === undefined || b.version > a.version ? b : a),
    undefined,
  );
  if (newest === undefined) return '';
  const previousVersion = Math.min(...applied.map((a) => a.version)) - 1;
  const previousPrd = store.q.prdVersionMarkdown(productId, previousVersion);
  return (
    '\n' +
    renderPrompt('orchestrator-replan', {
      previousVersion: String(previousVersion),
      previousPrd: previousPrd ?? '(not available)',
      newVersion: String(newest.version),
      newPrd: newest.markdown,
    })
  );
}

function describeBlocked(issues: readonly IssueState[]): string {
  const cancelled = new Map(
    issues.filter((i) => i.status === 'cancelled').map((i) => [i.id, i.number]),
  );
  const blocked = issues
    .filter((i) => i.status === 'open' || i.status === 'failed')
    .flatMap((i) => {
      const dead = i.dependsOn.flatMap((d) => {
        const n = cancelled.get(d);
        return n === undefined ? [] : [`#${String(n)}`];
      });
      return dead.length === 0
        ? []
        : [
            `- #${String(i.number)} ${i.title} (id ${i.id}) depends on cancelled ${dead.join(', ')}`,
          ];
    });
  return blocked.length === 0 ? '(none)' : blocked.join('\n');
}

/** "#3 Title" for a known issue, else the raw id. */
function issueLabel(id: string, issues: readonly IssueState[]): string {
  const issue = issues.find((i) => i.id === id);
  return issue === undefined ? id : `#${String(issue.number)} ${issue.title}`;
}

function describeTrigger(
  e: Event,
  issues: readonly IssueState[],
  questions: Readonly<Partial<Record<string, QuestionState>>>,
): string {
  switch (e.type) {
    case 'product.handed_off':
      return `- The owner handed off PRD version ${String(e.data.prdVersion)}: create the initial plan.`;
    case 'prd.applied':
      return (
        `- The owner applied PRD version ${String(e.data.version)}` +
        (e.data.summary === null ? '' : ` (${e.data.summary})`) +
        ': replan as described under "The PRD changed" below.'
      );
    case 'issue.failed': {
      const label = issueLabel(e.entityId, issues);
      return (
        `- Issue ${label} failed after ${String(e.data.attemptCount)} attempts: ${clip(e.data.reason)}. ` +
        'Rewrite it (smaller or clearer, using the feedback), split it into new issues, or ask the owner.'
      );
    }
    case 'issue.cancelled': {
      const stranded = (e.data.stranded ?? []).map((id) => issueLabel(id, issues));
      return (
        `- The owner cancelled issue ${issueLabel(e.entityId, issues)}; ${stranded.join(', ')} ` +
        `${stranded.length === 1 ? 'depends' : 'depend'} on it and can never start. ` +
        'Edit their dependencies or cancel them (see "Depends on cancelled issues" above).'
      );
    }
    case 'question.answered': {
      const q = questions[e.entityId];
      return `- The owner answered your question "${q?.text ?? e.entityId}": ${e.data.answer}`;
    }
    default:
      return `- ${e.type}`;
  }
}
