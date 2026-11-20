import { z } from 'zod';

// Branded ids (ARCHITECTURE §4.1). Values are ULIDs produced by the server's IdGen;
// the schemas only require a non-empty string so fixtures stay readable.
export const ProductIdSchema = z.string().min(1).brand<'ProductId'>();
export const IssueIdSchema = z.string().min(1).brand<'IssueId'>();
export const AttemptIdSchema = z.string().min(1).brand<'AttemptId'>();
export const AgentIdSchema = z.string().min(1).brand<'AgentId'>();
export const QuestionIdSchema = z.string().min(1).brand<'QuestionId'>();
export const InboxIdSchema = z.string().min(1).brand<'InboxId'>();
export const RunIdSchema = z.string().min(1).brand<'RunId'>();

export type ProductId = z.infer<typeof ProductIdSchema>;
export type IssueId = z.infer<typeof IssueIdSchema>;
export type AttemptId = z.infer<typeof AttemptIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type QuestionId = z.infer<typeof QuestionIdSchema>;
export type InboxId = z.infer<typeof InboxIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;

export type IdByKind = {
  product: ProductId;
  issue: IssueId;
  attempt: AttemptId;
  agent: AgentId;
  question: QuestionId;
  inbox: InboxId;
  run: RunId;
  /** usage.recorded rows (unbranded: the event's entityId is plain text). */
  usage: string;
};
export type IdKind = keyof IdByKind;

/** Produces fresh ids. Implementations live in the server; tests inject deterministic ones. */
export interface IdGen {
  next<K extends IdKind>(kind: K): IdByKind[K];
}

/** Source of time in epoch milliseconds. Shared code never reads the wall clock itself. */
export interface Clock {
  now(): number;
}
