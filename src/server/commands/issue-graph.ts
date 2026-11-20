// Reusable issue-creation helpers for orchestrator plans and owner issue commands:
// per-product number allocation, dependency resolution and cycle detection. Pure.

/** The next per-product issue number: one more than the highest so far (1 for none). */
export function nextIssueNumber(issues: Iterable<{ number: number }>): number {
  let max = 0;
  for (const { number } of issues) max = Math.max(max, number);
  return max + 1;
}

export type DependsOnContext<Id extends string> = {
  /** Plan-local keys → the ids allocated for them (empty for owner commands). */
  keys: ReadonlyMap<string, Id>;
  /** Ids of the product's existing issues. */
  existingIds: ReadonlySet<string>;
  /**
   * Ids of cancelled issues (in the caller's current working state). A dependency on one
   * could never complete, so it is refused.
   */
  cancelledIds: ReadonlySet<string>;
};

/**
 * Resolves `dependsOn` references (plan keys first, then existing issue ids of the product)
 * to ids, keeping the first occurrence of each. Unknown and cancelled references are refused.
 */
export function resolveDependsOn<Id extends string>(
  refs: readonly string[],
  ctx: DependsOnContext<Id>,
): { ok: true; ids: Id[] } | { ok: false; reason: string } {
  const ids: Id[] = [];
  for (const ref of refs) {
    const id = ctx.keys.get(ref) ?? (ctx.existingIds.has(ref) ? (ref as Id) : undefined);
    if (id === undefined) return { ok: false, reason: `unknown dependency "${ref}"` };
    if (ctx.cancelledIds.has(id)) {
      return { ok: false, reason: `dependency "${ref}" is cancelled and can never complete` };
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

/**
 * A dependency cycle in `graph` (issue id → the ids it depends on), as the path
 * `[a, b, …, a]`, or null when the graph is acyclic. Edges to ids outside the graph are ignored.
 */
export function findDependencyCycle(
  graph: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const done = new Set<string>();
  const onPath: string[] = [];

  const visit = (id: string): string[] | null => {
    const at = onPath.indexOf(id);
    if (at >= 0) return [...onPath.slice(at), id];
    if (done.has(id) || !graph.has(id)) return null;
    onPath.push(id);
    for (const dep of graph.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle !== null) return cycle;
    }
    onPath.pop();
    done.add(id);
    return null;
  };

  for (const id of graph.keys()) {
    const cycle = visit(id);
    if (cycle !== null) return cycle;
  }
  return null;
}
