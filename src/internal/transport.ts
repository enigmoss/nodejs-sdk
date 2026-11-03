import { EnigmossError } from '../error.js';
import { VERSION } from '../version.js';
import { hmacKey, orderIdempotencyKey, rawUrlEncode, signRequest, utf8 } from './crypto.js';

export const API_PREFIX = '/api/v4';

/** Lower bound of the attempt timeout when creating payouts and refunds: the gateway answers in up to ~160 s. */
export const PAYOUT_TIMEOUT = 180_000;

/** Which API key an endpoint accepts. `any`: the payment key, or the payout key when only that one is set. */
export type KeyScope = 'payment' | 'payout' | 'any';

/**
 * Retry class of an endpoint.
 * - `read`: GET, PATCH and calculations; retried on network errors, 429 and 502–504.
 * - `money`: POSTs that create objects or move money; retried only when it cannot cause a second effect.
 * - `once`: POSTs without idempotency; retried only when the request was certainly not sent.
 */
export type RetryClass = 'read' | 'money' | 'once';

export interface Endpoint {
  readonly method: string;
  /** Path after "/api/v4" with {name} placeholders. */
  readonly path: string;
  readonly scope: KeyScope;
  readonly retry: RetryClass;
  /** The server accepts (`supported`) or demands (`required`) an Idempotency-Key. */
  readonly idempotency?: 'supported' | 'required';
  /** Derive the default Idempotency-Key from the body `order_id`. */
  readonly orderKey?: boolean;
  /** Lower bound of the attempt timeout, ms. */
  readonly minTimeout?: number;
}

/** Last optional argument of every method. */
export interface RequestOptions {
  /** Timeout of one attempt, ms. Overrides the client timeout and the 180 s floor of payout and refund creation. */
  timeout?: number;
  /** Retries of this call; `0` disables them. */
  maxRetries?: number;
  /** Idempotency-Key of this call; wins over the key the SDK would choose. */
  idempotencyKey?: string;
  /** Aborts the call, including the wait between retries. */
  signal?: AbortSignal;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface Call {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: object | undefined;
  readonly body?: object | undefined;
}

export interface TransportConfig {
  readonly origin: string;
  readonly projectId: string;
  readonly paymentKey: string | undefined;
  readonly payoutKey: string | undefined;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly idempotency: boolean;
  readonly fetch: typeof fetch;
}

/**
 * Error codes on which a money POST protected by an Idempotency-Key is retried: the server did not
 * execute the request (rate limit, busy lock, the first request still running) or the API was
 * unreachable behind its gateway. Business errors are never retried: a failed payout keeps its
 * order_id, so a retry would hide the real cause behind a conflict.
 */
const SAFE_RETRY_CODES = new Set([
  'rate_limit.exceeded',
  'lock.not_acquired',
  'idempotency.in_progress',
  'dependency.unavailable',
]);

/** Error codes of fetch failures where the connection was never established, so nothing was sent. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ConnectionRefused',
  'FailedToOpenSocket',
]);

const BASE_DELAY = 500;
const MAX_BACKOFF = 8_000;
const MAX_RETRY_AFTER = 10;

const USER_AGENT = `enigmoss-node-sdk/${VERSION}`;

interface Failure {
  readonly error: EnigmossError;
  /** Delay before the next attempt in ms, `'backoff'`, or `null` when the error must be thrown. */
  readonly delay: number | 'backoff' | null;
}

/** Builds, signs and sends requests; retries them safely. */
export class Transport {
  private readonly keys = new Map<string, Promise<CryptoKey>>();

  constructor(private readonly config: TransportConfig) {}

  async execute<T>(endpoint: Endpoint, call: Call, options: RequestOptions = {}): Promise<T> {
    const { config } = this;
    const method = endpoint.method;
    const path = call.params === undefined ? endpoint.path : resolvePath(endpoint.path, call.params);
    const requestUri = buildRequestUri(API_PREFIX + path, call.query);
    const body = method === 'GET' ? null : utf8(JSON.stringify(call.body ?? {}));
    const key = await this.key(endpoint.scope, method, requestUri);

    const idempotencyKey = await this.idempotencyKey(endpoint, requestUri, call.body, options.idempotencyKey);
    // Only a key the SDK keeps for the whole operation makes a repeat of a sent money POST a replay.
    const protectedByKey = idempotencyKey !== null && (options.idempotencyKey !== undefined || config.idempotency);
    const maxRetries = Math.max(0, options.maxRetries ?? config.maxRetries);
    const timeout = options.timeout ?? Math.max(config.timeout, endpoint.minTimeout ?? 0);

    let unknownBefore: EnigmossError | null = null;
    for (let attempt = 1; ; attempt++) {
      const timestamp = Math.floor(Date.now() / 1000);
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'X-Project-Uuid': config.projectId,
        'X-Timestamp': String(timestamp),
        'X-Signature': await signRequest(
          key,
          timestamp,
          config.projectId,
          method,
          requestUri,
          body ?? new Uint8Array(),
        ),
      };
      if (body !== null) {
        headers['Content-Type'] = 'application/json';
      }
      if (idempotencyKey !== null) {
        headers['Idempotency-Key'] = idempotencyKey;
      }

      const outcome = await this.attempt<T>(
        endpoint,
        requestUri,
        headers,
        body,
        timeout,
        options.signal,
        protectedByKey,
      );
      if (!('error' in outcome)) {
        return outcome.value;
      }

      const { error, delay } = outcome;
      if (delay === null || attempt > maxRetries || options.signal?.aborted) {
        // A retry answered "not executed" says nothing about an earlier attempt that may have run.
        throw unknownBefore !== null && !error.outcomeUnknown ? withUnknownOutcome(error, unknownBefore) : error;
      }
      if (error.outcomeUnknown) {
        unknownBefore ??= error;
      }
      await sleep(delay === 'backoff' ? backoff(attempt) : delay, options.signal);
    }
  }

  private async attempt<T>(
    endpoint: Endpoint,
    requestUri: string,
    headers: Record<string, string>,
    body: Uint8Array<ArrayBuffer> | null,
    timeout: number,
    signal: AbortSignal | undefined,
    protectedByKey: boolean,
  ): Promise<{ value: T } | Failure> {
    const timer = AbortSignal.timeout(timeout);
    const init: RequestInit = {
      method: endpoint.method,
      headers,
      body,
      redirect: 'manual',
      signal: signal === undefined ? timer : AbortSignal.any([timer, signal]),
    };

    let response: Response;
    let text: string;
    try {
      const send = this.config.fetch;
      response = await send(`${this.config.origin}${requestUri}`, init);
      text = await response.text();
    } catch (cause) {
      return transportFailure(endpoint.retry, protectedByKey, cause, timer, signal);
    }

    if (response.status >= 200 && response.status < 300) {
      try {
        return { value: (text === '' ? null : JSON.parse(text)) as T };
      } catch (cause) {
        // The operation most likely succeeded, but the answer cannot be read.
        return {
          error: new EnigmossError(`HTTP ${response.status} response is not valid JSON.`, {
            code: 'response.invalid',
            status: response.status,
            outcomeUnknown: true,
            requestId: response.headers.get('X-Request-Id'),
            body: text,
            cause,
          }),
          delay: null,
        };
      }
    }

    return errorResponse(endpoint.retry, protectedByKey, response, text);
  }

  private key(scope: KeyScope, method: string, requestUri: string): Promise<CryptoKey> {
    const { paymentKey, payoutKey } = this.config;
    const secret = scope === 'payment' ? paymentKey : scope === 'payout' ? payoutKey : (paymentKey ?? payoutKey);
    if (secret === undefined) {
      const option = scope === 'payout' ? 'payoutKey' : 'paymentKey';
      throw new EnigmossError(`${method} ${requestUri} needs the ${scope} key: pass ${option} to the client.`, {
        code: 'config',
      });
    }
    let key = this.keys.get(secret);
    if (key === undefined) {
      key = hmacKey(secret);
      this.keys.set(secret, key);
    }
    return key;
  }

  private async idempotencyKey(
    endpoint: Endpoint,
    requestUri: string,
    body: object | undefined,
    explicit: string | undefined,
  ): Promise<string | null> {
    if (explicit !== undefined) {
      return explicit;
    }
    if (endpoint.idempotency === undefined) {
      return null;
    }
    if (!this.config.idempotency) {
      return endpoint.idempotency === 'required' ? crypto.randomUUID() : null;
    }
    const orderId = (body as { order_id?: unknown } | undefined)?.order_id;
    if (endpoint.orderKey && typeof orderId === 'string') {
      return orderIdempotencyKey(requestUri, orderId);
    }
    return crypto.randomUUID();
  }
}

function transportFailure(
  retry: RetryClass,
  protectedByKey: boolean,
  cause: unknown,
  timer: AbortSignal,
  signal: AbortSignal | undefined,
): Failure {
  if (signal?.aborted) {
    return {
      error: new EnigmossError('The request was aborted.', { code: 'aborted', outcomeUnknown: true, cause }),
      delay: null,
    };
  }
  if (timer.aborted) {
    const error = new EnigmossError('The request timed out; it may have been executed.', {
      code: 'timeout',
      outcomeUnknown: true,
      cause,
    });
    return { error, delay: retry === 'read' || (retry === 'money' && protectedByKey) ? 'backoff' : null };
  }

  const notSent = errorCodes(cause).some((code) => NOT_SENT_CODES.has(code));
  const error = new EnigmossError(
    notSent
      ? 'Cannot connect to the API host; the request was not sent.'
      : 'The connection failed; the request may have been executed.',
    { code: 'network', outcomeUnknown: !notSent, cause },
  );
  const retryable = notSent || retry === 'read' || (retry === 'money' && protectedByKey);
  return { error, delay: retryable ? 'backoff' : null };
}

function errorResponse(retry: RetryClass, protectedByKey: boolean, response: Response, text: string): Failure {
  const status = response.status;
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: a proxy or load balancer page, kept as text.
  }

  const envelope = isObject(body) ? body : {};
  const error = isObject(envelope.error) ? envelope.error : {};
  const meta = isObject(envelope.meta) ? envelope.meta : {};
  const hasEnvelope = typeof error.code === 'string';
  const code = hasEnvelope ? (error.code as string) : `http.${status}`;
  const requestId = typeof meta.request_id === 'string' ? meta.request_id : response.headers.get('X-Request-Id');
  const retryAfterHeader = response.headers.get('Retry-After')?.trim() ?? '';
  const retryAfter = Number.isInteger(meta.retry_after)
    ? (meta.retry_after as number)
    : /^\d{1,10}$/.test(retryAfterHeader)
      ? Number(retryAfterHeader)
      : null;

  const message = typeof error.message === 'string' ? error.message : `HTTP ${status} from the API host.`;
  const enigmossError = new EnigmossError(`${message} [${code}${requestId === null ? '' : `, request ${requestId}`}]`, {
    code,
    status,
    outcomeUnknown: status >= 500 || code === 'idempotency.in_progress',
    requestId,
    body,
  });

  const transient = status === 429 || (status >= 502 && status <= 504);
  const retryable =
    retry === 'read'
      ? transient
      : retry === 'money' && protectedByKey && (hasEnvelope ? SAFE_RETRY_CODES.has(code) : transient);
  if (!retryable) {
    return { error: enigmossError, delay: null };
  }
  if (retryAfter !== null) {
    return { error: enigmossError, delay: retryAfter <= MAX_RETRY_AFTER ? retryAfter * 1000 : null };
  }
  return { error: enigmossError, delay: 'backoff' };
}

function withUnknownOutcome(error: EnigmossError, earlier: EnigmossError): EnigmossError {
  return new EnigmossError(`${error.message} An earlier attempt may have been executed.`, {
    code: error.code,
    status: error.status,
    outcomeUnknown: true,
    requestId: error.requestId,
    body: error.body,
    cause: earlier,
  });
}

/** Exponential backoff with full jitter: random in [0, min(8 s, 0.5 s * 2^(attempt-1))). */
export function backoff(attempt: number): number {
  return Math.round(Math.random() * Math.min(MAX_BACKOFF, BASE_DELAY * 2 ** (attempt - 1)));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        new EnigmossError('The request was aborted.', { code: 'aborted', outcomeUnknown: true, cause: signal?.reason }),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function resolvePath(path: string, params: Readonly<Record<string, string>>): string {
  return path.replace(/\{([a-z_]+)\}/g, (_, name: string) => rawUrlEncode(String(params[name])));
}

/**
 * The request URI is built once; the same string is signed and sent. Null and undefined values are
 * dropped, order is kept, and a bare "?" is never emitted: the server signs the raw URI.
 */
export function buildRequestUri(path: string, query: object | undefined): string {
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(query ?? {}) as [string, QueryValue][]) {
    if (value === null || value === undefined) {
      continue;
    }
    pairs.push(`${rawUrlEncode(name)}=${rawUrlEncode(String(value))}`);
  }
  if (pairs.length === 0) {
    return path;
  }
  return `${path}${path.includes('?') ? '&' : '?'}${pairs.join('&')}`;
}

function errorCodes(cause: unknown): string[] {
  const codes: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!isObject(value) || depth > 3) {
      return;
    }
    if (typeof value.code === 'string') {
      codes.push(value.code);
    }
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors)) {
      for (const item of value.errors) {
        visit(item, depth + 1);
      }
    }
  };
  visit(cause, 0);
  return codes;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
