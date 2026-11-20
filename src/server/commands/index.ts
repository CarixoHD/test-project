export { applyPlan, type ApplyPlanResult, type CommandDeps } from './apply-plan.ts';
export {
  findDependencyCycle,
  nextIssueNumber,
  resolveDependsOn,
  type DependsOnContext,
} from './issue-graph.ts';
