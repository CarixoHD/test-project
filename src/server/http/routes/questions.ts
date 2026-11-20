import type { Hono } from 'hono';
import { AnswerQuestionRequestSchema, type OkResponse } from '../../../shared/dto.ts';
import { answerQuestion } from '../../commands/index.ts';
import { readJson } from '../body.ts';
import type { AppDeps } from '../deps.ts';
import { fail } from '../errors.ts';

/** Owner answers to agent questions (ARCHITECTURE §6 flow 8); a second answer → 409. */
export function registerQuestionRoutes(app: Hono, { store, ids }: AppDeps): void {
  app.post('/api/questions/:id/answer', async (c) => {
    const { text } = AnswerQuestionRequestSchema.parse(await readJson(c));
    const r = answerQuestion({ store, ids }, c.req.param('id'), text);
    if (!r.ok) fail(r);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });
}
