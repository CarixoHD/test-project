import type { Hono } from 'hono';
import {
  AddIssueRequestSchema,
  EditIssueRequestSchema,
  type AddIssueResponse,
  type EditIssueResponse,
  type OkResponse,
} from '../../../shared/dto.ts';
import { IssueIdSchema, ProductIdSchema } from '../../../shared/ids.ts';
import { addIssue, cancelIssue, editIssue } from '../../commands/index.ts';
import type { AppDeps } from '../deps.ts';
import { readJson } from '../body.ts';
import { fail } from '../errors.ts';

/** Owner issue commands (ARCHITECTURE §4.3): add, edit (rev-guarded), cancel. */
export function registerIssueRoutes(app: Hono, { store, ids }: AppDeps): void {
  const deps = { store, ids };

  app.post('/api/products/:id/issues', async (c) => {
    const productId = ProductIdSchema.parse(c.req.param('id'));
    const input = AddIssueRequestSchema.parse(await readJson(c));
    const r = addIssue(deps, productId, input);
    if (!r.ok) fail(r);
    const body: AddIssueResponse = { ok: true, issueId: r.issueId, number: r.number };
    return c.json(body);
  });

  app.patch('/api/issues/:id', async (c) => {
    const id = IssueIdSchema.parse(c.req.param('id'));
    const input = EditIssueRequestSchema.parse(await readJson(c));
    const r = editIssue(deps, id, input);
    if (!r.ok) fail(r);
    const body: EditIssueResponse = { ok: true, rev: r.rev };
    return c.json(body);
  });

  app.post('/api/issues/:id/cancel', (c) => {
    const id = IssueIdSchema.parse(c.req.param('id'));
    const r = cancelIssue(deps, id);
    if (!r.ok) fail(r);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });
}
