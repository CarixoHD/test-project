import { z } from 'zod';
import {
  AddIssueResponseSchema,
  CreateProductResponseSchema,
  EditIssueResponseSchema,
  OkResponseSchema,
  StateResponseSchema,
  type AddIssueRequest,
  type AddIssueResponse,
  type CreateProductRequest,
  type CreateProductResponse,
  type EditIssueRequest,
  type EditIssueResponse,
  type OkResponse,
  type ProductSettingsUpdateRequest,
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
}

export async function request<T>(path: string, opts: RequestOptions<T>): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const headers = new Headers({ Accept: 'application/json' });
  const init: RequestInit = { method: opts.method ?? 'GET', headers, signal };
  if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (cause) {
    if (timeout.aborted) {
      throw new ApiError('timeout', `The server did not answer ${path} in time`, 0, { cause });
    }
    if (opts.signal?.aborted) throw cause;
    throw new ApiError('network', 'Cannot reach the Vibecode server; is it running?', 0, {
      cause,
    });
  }

  const body = await readJson(res);
  if (!res.ok) throw errorFromResponse(res, body);
  const parsed = opts.schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('bad_response', `Unexpected response from ${path}`, res.status, {
      cause: parsed.error,
    });
  }
  return parsed.data;
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

/** Hands the PRD draft to the orchestrator; the phase change arrives as events. */
export function handoffProduct(productId: string, signal?: AbortSignal): Promise<OkResponse> {
  return request(`/api/products/${encodeURIComponent(productId)}/handoff`, {
    method: 'POST',
    schema: OkResponseSchema,
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
