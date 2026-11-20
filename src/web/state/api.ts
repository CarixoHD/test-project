import { z } from 'zod';
import {
  AddIssueResponseSchema,
  ClaudeCodeTokenViewSchema,
  CreateProductResponseSchema,
  EditIssueResponseSchema,
  GitTokenViewSchema,
  OkResponseSchema,
  SessionResponseSchema,
  SettingsResponseSchema,
  SettingsUpdateResponseSchema,
  StartPreviewResponseSchema,
  StateResponseSchema,
  type AddIssueRequest,
  type AnswerQuestionRequest,
  type AddIssueResponse,
  type ClaudeCodeTokenView,
  type CreateProductRequest,
  type CreateProductResponse,
  type EditIssueRequest,
  type EditIssueResponse,
  type GitTokenView,
  type OkResponse,
  type PasswordChangeRequest,
  type ProductSettingsUpdateRequest,
  type SessionResponse,
  type SettingsResponse,
  type SettingsUpdateRequest,
  type SettingsUpdateResponse,
  type StartPreviewResponse,
  type StateResponse,
} from '../../shared/dto.ts';

// Typed HTTP client for the Vibecode API (ARCHITECTURE §4.3). Every call validates the
// response with the DTO schema from src/shared/dto.ts, sends JSON bodies, and turns every
// failure into an ApiError, so callers handle one error type.

const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  /** The server's `{error:{code}}`, or a client code: network | timeout | bad_response | http_<status>. */
  readonly code: string;
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const ErrorBodySchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string() }),
});

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions<T> {
  method?: HttpMethod;
  /** Serialised as JSON. */
  body?: unknown;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** A 401 here is an expected answer (wrong password), not a lost session. */
  expectUnauthorized?: boolean;
}

// ---- lost sessions ------------------------------------------------------------------------
// With an owner password set, any API call can answer 401 once the session expired or was
// ended elsewhere; listeners (the auth gate) then show the Login page.

const unauthorizedListeners = new Set<() => void>();

/** Calls `listener` whenever the server says the session is missing; returns the unsubscribe. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized(): void {
  for (const listener of [...unauthorizedListeners]) listener();
}

export async function request<T>(path: string, opts: RequestOptions<T>): Promise<T> {
  const res = await send(path, opts);
  const body = await readJson(res);
  if (!res.ok) {
    if (res.status === 401 && opts.expectUnauthorized !== true) notifyUnauthorized();
    throw errorFromResponse(res, body);
  }
  const parsed = opts.schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_response', `Unexpected response from ${path}`, res.status, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** GET of a plain-text resource; null on 404, every other failure → ApiError. */
async function requestText(
  path: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const res = await send(path, { ...opts, accept: 'text/plain' });
  if (res.status === 404) return null;
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized();
    throw errorFromResponse(res, await readJson(res));
  }
  return res.text();
}

/** One fetch with timeout and JSON mutation headers; transport failures → ApiError. */
async function send(
  path: string,
  opts: Omit<RequestOptions<unknown>, 'schema'> & { accept?: string },
): Promise<Response> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const headers = new Headers({ Accept: opts.accept ?? 'application/json' });
  const method = opts.method ?? 'GET';
  const init: RequestInit = { method, headers, signal };
  // The server accepts only JSON mutations (CSRF defence, ADR 9), even those without a body.
  if (method !== 'GET') headers.set('Content-Type', 'application/json');
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  try {
    return await fetch(path, init);
  } catch (cause) {
    if (timeout.aborted) {
      throw new ApiError('timeout', `The server did not answer ${path} in time`, 0, { cause });
    }
    if (opts.signal?.aborted) throw cause;
    throw new ApiError('network', 'Cannot reach the Vibecode server; is it running?', 0, {
      cause,
    });
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON (e.g. a proxy error page): the status decides what the caller sees.
    return undefined;
  }
}

function errorFromResponse(res: Response, body: unknown): ApiError {
  const parsed = ErrorBodySchema.safeParse(body);
  if (parsed.success) {
    return new ApiError(parsed.data.error.code, parsed.data.error.message, res.status);
  }
  const reason = res.statusText === '' ? 'request failed' : res.statusText;
  return new ApiError(`http_${res.status}`, `Server error ${res.status}: ${reason}`, res.status);
}

// ---- endpoints ----------------------------------------------------------------------------

export function getState(signal?: AbortSignal): Promise<StateResponse> {
  return request('/api/state', { schema: StateResponseSchema, ...(signal ? { signal } : {}) });
}

export function createProduct(
  body: CreateProductRequest,
  signal?: AbortSignal,
): Promise<CreateProductResponse> {
  return request('/api/products', {
    method: 'POST',
    body,
    schema: CreateProductResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Sends the owner's message to the sparring agent; the reply arrives later as an event. */
export function sendSparMessage(
  productId: string,
  message: string,
  signal?: AbortSignal,
): Promise<OkResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/spar`, {
    method: 'POST',
    body: { message },
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Stores the owner's edited PRD draft. */
export function savePrdDraft(
  productId: string,
  markdown: string,
  signal?: AbortSignal,
): Promise<OkResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/prd-draft`, {
    method: 'PUT',
    body: { markdown },
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Changes a product's settings; the new values arrive as a `product.settings_changed` event. */
export function updateProductSettings(
  productId: string,
  body: ProductSettingsUpdateRequest,
  signal?: AbortSignal,
): Promise<OkResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/settings`, {
    method: 'PATCH',
    body,
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Whether the product's git remote token is set; never the token, at most its last 4 chars. */
export function getGitToken(productId: string, signal?: AbortSignal): Promise<GitTokenView> {
  return request(`/api/products/${encodeURIComponent(productId)}/git-token`, {
    schema: GitTokenViewSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Sets (string) or removes (null) the product's git remote token (write-only). */
export function updateGitToken(
  productId: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<GitTokenView> {
  return request(`/api/products/${encodeURIComponent(productId)}/git-token`, {
    method: 'PUT',
    body: { token },
    schema: GitTokenViewSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Hands the PRD draft to the orchestrator; the phase change arrives as events. */
export function handoffProduct(productId: string, signal?: AbortSignal): Promise<OkResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/handoff`, {
    method: 'POST',
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

const CLAUDE_TOKEN_URL = '/api/backends/claude-code/token';

/** Whether the Claude subscription token (ADR 13) is set; never the token, at most its last 4. */
export function getClaudeCodeToken(signal?: AbortSignal): Promise<ClaudeCodeTokenView> {
  return request(CLAUDE_TOKEN_URL, {
    schema: ClaudeCodeTokenViewSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Sets (string) or removes (null) the Claude subscription token (write-only). */
export function updateClaudeCodeToken(
  token: string | null,
  signal?: AbortSignal,
): Promise<ClaudeCodeTokenView> {
  return request(CLAUDE_TOKEN_URL, {
    method: 'PUT',
    body: { token },
    schema: ClaudeCodeTokenViewSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Clears an account-wide backend limit, e.g. Claude Code's needs_login after logging in. */
export function clearBackendLimit(backend: string, signal?: AbortSignal): Promise<OkResponse> {
  return request(`/api/backends/${encodeURIComponent(backend)}/clear`, {
    method: 'POST',
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Applies the edited PRD draft as the next version; 409 when it equals the latest version. */
export function applyPrdChanges(productId: string, signal?: AbortSignal): Promise<OkResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/apply-prd`, {
    method: 'POST',
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Pauses the product's build; 409 when it is already paused. */
export function pauseProduct(productId: string, signal?: AbortSignal): Promise<OkResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/pause`, {
    method: 'POST',
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Resumes the product's build; 409 when it is not paused or its budget is still exhausted. */
export function resumeProduct(productId: string, signal?: AbortSignal): Promise<OkResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/resume`, {
    method: 'POST',
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Waits for the server's 60 s readiness poll plus worktree, image and container start. */
const START_PREVIEW_TIMEOUT_MS = 3 * 60_000;

/**
 * Runs the product's current main as a preview (replacing a running one) and resolves with its
 * URL once it answers; 409 without a preview config or when it fails to start.
 */
export function startPreview(
  productId: string,
  signal?: AbortSignal,
): Promise<StartPreviewResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/preview`, {
    method: 'POST',
    schema: StartPreviewResponseSchema,
    timeoutMs: START_PREVIEW_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
}

/** Stops the product's preview; 409 when none is running. */
export function stopPreview(productId: string, signal?: AbortSignal): Promise<OkResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/preview`, {
    method: 'DELETE',
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Account-wide settings; API keys appear only as provider + last 4 characters. */
export function getSettings(signal?: AbortSignal): Promise<SettingsResponse> {
  return request('/api/settings', {
    schema: SettingsResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Updates the given settings sections; answers with the settings after the update. */
export function updateSettings(
  body: SettingsUpdateRequest,
  signal?: AbortSignal,
): Promise<SettingsUpdateResponse> {
  return request('/api/settings', {
    method: 'PUT',
    body,
    schema: SettingsUpdateResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Adds an owner issue to the product; the card arrives later as `issue.created`. */
export function addIssue(
  productId: string,
  body: AddIssueRequest,
  signal?: AbortSignal,
): Promise<AddIssueResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/issues`, {
    method: 'POST',
    body,
    schema: AddIssueResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Edits an issue based on revision `body.rev`; a stale rev is an ApiError with status 409. */
export function editIssue(
  issueId: string,
  body: EditIssueRequest,
  signal?: AbortSignal,
): Promise<EditIssueResponse> {
  return request(`/api/issues/${encodeURIComponent(issueId)}`, {
    method: 'PATCH',
    body,
    schema: EditIssueResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Cancels an issue; the status change arrives as `issue.cancelled`. */
export function cancelIssue(issueId: string, signal?: AbortSignal): Promise<OkResponse> {
  return request(`/api/issues/${encodeURIComponent(issueId)}/cancel`, {
    method: 'POST',
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Marks an inbox item read; the change arrives as `inbox.read` (already read is fine). */
export function markInboxRead(itemId: string, signal?: AbortSignal): Promise<OkResponse> {
  return request(`/api/inbox/${encodeURIComponent(itemId)}/read`, {
    method: 'POST',
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Answers an agent's question; 409 when it was already answered. */
export function answerQuestion(
  questionId: string,
  text: string,
  signal?: AbortSignal,
): Promise<OkResponse> {
  const body: AnswerQuestionRequest = { text };
  return request(`/api/questions/${encodeURIComponent(questionId)}/answer`, {
    method: 'POST',
    body,
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

// ---- session --------------------------------------------------------------------------------

/** Whether a password is set and whether this browser holds a valid session. */
export function getSession(signal?: AbortSignal): Promise<SessionResponse> {
  return request('/api/session', { schema: SessionResponseSchema, ...(signal ? { signal } : {}) });
}

/** Logs in; a wrong password is an ApiError with status 401, too many tries status 429. */
export function login(password: string, signal?: AbortSignal): Promise<OkResponse> {
  return request('/api/login', {
    method: 'POST',
    body: { password },
    schema: OkResponseSchema,
    expectUnauthorized: true,
    ...(signal ? { signal } : {}),
  });
}

export function logout(signal?: AbortSignal): Promise<OkResponse> {
  return request('/api/logout', {
    method: 'POST',
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

/** Sets the first password or changes it (then `current` is required); ends other sessions. */
export function changePassword(
  body: PasswordChangeRequest,
  signal?: AbortSignal,
): Promise<OkResponse> {
  return request('/api/settings/password', {
    method: 'POST',
    body,
    schema: OkResponseSchema,
    ...(signal ? { signal } : {}),
  });
}

export type SessionCheck = 'authenticated' | 'unauthenticated' | 'unknown';

/**
 * For EventSource failures, which cannot see the HTTP status: asks GET /api/session and tells
 * the onUnauthorized listeners when the session is gone. `unknown` when the server is unreachable.
 */
export async function recheckSession(): Promise<SessionCheck> {
  let session: SessionResponse;
  try {
    session = await getSession();
  } catch {
    return 'unknown';
  }
  if (session.passwordSet && !session.authenticated) {
    notifyUnauthorized();
    return 'unauthenticated';
  }
  return 'authenticated';
}

/** Artifacts of an attempt: `diff` (diff.patch) and `check` (check output). */
export type AttemptArtifact = 'diff' | 'check';

/** GET /api/attempts/:id/diff | /check as text; null when the attempt has none (404). */
export function getAttemptArtifact(
  attemptId: string,
  kind: AttemptArtifact,
  signal?: AbortSignal,
): Promise<string | null> {
  return requestText(`/api/attempts/${encodeURIComponent(attemptId)}/${kind}`, {
    ...(signal ? { signal } : {}),
  });
}
