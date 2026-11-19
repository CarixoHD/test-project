import { z } from 'zod';

// Structured results agents return through the `finish` tool or `--json-schema`
// (ARCHITECTURE §4.5), plus the product repo's `.vibecode/project.json` contract (§5).
// All of it is untrusted agent output: validate before use.

const Text = z.string().min(1);
const Argv = z.array(Text).min(1);

/** A repo-relative, normalised path that cannot escape /workspace. */
const RelativePath = Text.refine(
  (p) =>
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !p.includes('\0') &&
    p.split('/').every((seg) => seg !== '..' && seg !== '.' && seg !== ''),
  { message: 'must be a relative path inside the repository' },
);

export const ProjectConfigSchema = z.object({
  /** argv run in /workspace with network none; never a shell string. */
  check: Argv,
  /** Lockfiles etc. whose content is hashed into the product image tag. */
  imageInputs: z.array(RelativePath),
  preview: z.object({ command: Argv, port: z.int().min(1).max(65535) }).optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const SparResultSchema = z.object({
  reply: Text,
  prdMarkdown: z.string().optional(),
});
export type SparResult = z.infer<typeof SparResultSchema>;

export const IssueOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    /** Plan-local key so ops in the same plan can depend on each other. */
    key: Text,
    title: Text,
    body: Text,
    /** Keys from this plan or ids of existing issues. */
    dependsOn: z.array(Text),
    priority: z.int().optional(),
  }),
  z.object({
    op: z.literal('edit'),
    id: Text,
    title: Text.optional(),
    body: Text.optional(),
    dependsOn: z.array(Text).optional(),
  }),
  z.object({ op: z.literal('cancel'), id: Text, reason: Text }),
  /** failed → open with the attempt count reset. */
  z.object({ op: z.literal('rewrite'), id: Text, body: Text }),
]);
export type IssueOp = z.infer<typeof IssueOpSchema>;

export const PlanResultSchema = z.object({
  issueOps: z.array(IssueOpSchema),
  questions: z.array(Text),
  summary: Text,
  project: ProjectConfigSchema.optional(),
});
export type PlanResult = z.infer<typeof PlanResultSchema>;

export const ImplResultSchema = z.object({
  summary: Text,
  /** Set when the implementer is blocked and needs the owner. */
  question: Text.optional(),
});
export type ImplResult = z.infer<typeof ImplResultSchema>;

export const ReviewResultSchema = z.object({
  approve: z.boolean(),
  findings: z.array(Text),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
