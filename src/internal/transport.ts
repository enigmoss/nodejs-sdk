import { EnigmossError } from '../error.js';
import { VERSION } from '../version.js';
import { concat, hex, hmacKey, orderIdempotencyKey, rawUrlEncode, signRequest, unhex, utf8 } from './crypto.js';
import {
  acceptOrigin,
  FALLBACK_PAUSE,
  MAX_CLOCK_DRIFT,
  MIN_CLOCK_DRIFT,
  originLifetime,
  PROBE_TIMEOUT,
  PROBE_URI,
  RESPONSE_TOLERANCE,
} from './origin.js';

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

/** Argument of the `onOriginChange` option: the client moved to another API origin. */
export interface OriginChange {
  /** The origin the requests could not reach. */
  readonly previous: string;
  /** The origin the client sends to from now on. */
  readonly current: string;
  /** When the client goes back to `baseUrl`. */
  readonly expiresAt: Date;
}

export interface TransportConfig {
  readonly origin: string;
  /** Origin of the fallback host; `undefined` turns the fallback off. */
  readonly fallbackOrigin: string | undefined;
  readonly onOriginChange: ((change: OriginChange) => void) | undefined;
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
  /** The connection to the API host was certainly never established: the only failure a fallback answers. */
  readonly unreachable?: boolean;
}

/** What the fallback host answered to the probe. */
type Probe =
  | { readonly kind: 'origin'; readonly origin: string; readonly lifetime: number; readonly body: unknown }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'failed'; readonly error: (cause: EnigmossError) => EnigmossError };

/** Builds, signs and sends requests; retries them safely. */
export class Transport {
  private readonly keys = new Map<string, Promise<CryptoKey>>();

  /** The origin a fallback host named and the time (ms) until which it replaces `config.origin`. */
  private moved: { readonly origin: string; readonly expiresAt: number } | null = null;
  /** No fallback is tried before this time (ms): the last one did not move the client. */
  private pausedUntil = 0;
  /** The probe in flight: concurrent calls wait for it instead of sending their own. */
  private flight: Promise<Probe> | null = null;

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
    // Only a client with a fallback host has a time budget: the probe and the retries after a move must fit in it.
    const deadline =
      config.fallbackOrigin === undefined
        ? Number.POSITIVE_INFINITY
        : Date.now() + timeout * (maxRetries + 1) + MAX_RETRY_AFTER * 1000 * maxRetries;

    let origin = this.activeOrigin();
    let moved = false;
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
        origin,
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
      const last = delay === null || attempt > maxRetries || options.signal?.aborted;
      const wait = last || delay === null ? 0 : delay === 'backoff' ? backoff(attempt) : delay;
      // After a move the call keeps its deadline: no retry starts past it.
      if (last || (moved && Date.now() + wait >= deadline)) {
        // A retry answered "not executed" says nothing about an earlier attempt that may have run.
        const thrown =
          unknownBefore !== null && !error.outcomeUnknown ? withUnknownOutcome(error, unknownBefore) : error;
        if (config.fallbackOrigin !== undefined && outcome.unreachable && !moved && !options.signal?.aborted) {
          const next = await this.fallback(origin, deadline, thrown, options.signal);
          if (next !== null && method === 'GET' && requestUri === PROBE_URI && next.body !== undefined) {
            // The call asked for what the probe has just fetched.
            return next.body as T;
          }
          if (next !== null && next.origin !== origin) {
            // The same body and Idempotency-Key go to the new origin; the attempts start over.
            origin = next.origin;
            moved = true;
            attempt = 0;
            continue;
          }
        }
        throw thrown;
      }
      if (error.outcomeUnknown) {
        unknownBefore ??= error;
      }
      await sleep(wait, options.signal);
    }
  }

  /** The origin to send to: the one a fallback host named, until it expires, else `baseUrl`. */
  private activeOrigin(): string {
    const { moved } = this;
    if (moved !== null) {
      if (Date.now() < moved.expiresAt) {
        return moved.origin;
      }
      this.moved = null;
    }
    return this.config.origin;
  }

  /**
   * Runs once per call, after the retries, when `failed` could not be reached. Resolves with the
   * origin to continue on (and the probe response, when a probe ran), or `null` when the call fails
   * with its own error; rejects with the error of the fallback host, `cause` attached.
   */
  private async fallback(
    failed: string,
    deadline: number,
    cause: EnigmossError,
    signal: AbortSignal | undefined,
  ): Promise<{ origin: string; body?: unknown } | null> {
    if (this.config.fallbackOrigin === undefined || deadline - Date.now() < PROBE_TIMEOUT) {
      return null;
    }
    let flight = this.flight;
    if (flight === null) {
      const active = this.activeOrigin();
      if (active !== failed) {
        // Another call has moved the client while this one was retrying.
        return { origin: active };
      }
      if (Date.now() < this.pausedUntil) {
        return null;
      }
      const started = this.relocate(failed, deadline);
      flight = started;
      this.flight = started;
      void started.then(() => {
        if (this.flight === started) {
          this.flight = null;
        }
      });
    }
    const probe = await abortable(flight, signal);
    if (probe.kind === 'failed') {
      throw probe.error(cause);
    }
    return probe.kind === 'origin' ? { origin: probe.origin, body: probe.body } : null;
  }

  /** One shared probe and its bookkeeping: a new origin is remembered, anything else starts the pause. */
  private async relocate(failed: string, deadline: number): Promise<Probe> {
    let probe: Probe;
    try {
      probe = await this.probe(deadline);
    } catch {
      probe = { kind: 'unreachable' };
    }
    const now = Date.now();
    if (probe.kind === 'origin' && probe.origin !== failed) {
      const expiresAt = now + probe.lifetime * 1000;
      this.moved = { origin: probe.origin, expiresAt };
      this.pausedUntil = 0;
      this.notify({ previous: failed, current: probe.origin, expiresAt: new Date(expiresAt) });
    } else {
      // Only the time is kept, never the answer: a call during the pause fails with its own error.
      this.pausedUntil = now + FALLBACK_PAUSE;
    }
    return probe;
  }

  /**
   * Asks the fallback host for the API origin: a signed GET of the platform brand, sent past the
   * retry loop. The answer counts only when it is signed with the key that signed the request.
   *
   * Every probe request carries a one-time nonce in its signed URI. The response signature covers
   * the request signature, so an answer fits the one request it was given to: without the nonce
   * the request signature would depend on the second alone, and the clock correction below takes
   * that second from an unsigned `server_time`, which would let a recorded answer be replayed.
   */
  private async probe(deadline: number): Promise<Probe> {
    const { config } = this;
    const key = await this.key('any', 'GET', PROBE_URI);
    // The probe corrects a wrong local clock once, for itself: seconds added to the local time.
    let offset = 0;
    for (let corrected = false; ; corrected = true) {
      const timestamp = Math.floor(Date.now() / 1000) + offset;
      const requestUri = `${PROBE_URI}?nonce=${hex(crypto.getRandomValues(new Uint8Array(16)).buffer)}`;
      const signature = await signRequest(key, timestamp, config.projectId, 'GET', requestUri, new Uint8Array());

      let response: Response;
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        const send = config.fetch;
        response = await send(`${config.fallbackOrigin}${requestUri}`, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
            'X-Project-Uuid': config.projectId,
            'X-Timestamp': String(timestamp),
            'X-Signature': signature,
          },
          body: null,
          redirect: 'manual',
          signal: AbortSignal.timeout(PROBE_TIMEOUT),
        });
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        return { kind: 'unreachable' };
      }
      const text = new TextDecoder().decode(bytes);
      const status = response.status;

      if (status < 200 || status >= 300) {
        const failure = readError(response, text);
        const serverTime = failure.details.server_time;
        if (
          !corrected &&
          failure.code === 'auth.timestamp_expired' &&
          typeof serverTime === 'number' &&
          Number.isInteger(serverTime) &&
          deadline - Date.now() >= PROBE_TIMEOUT
        ) {
          const drift = serverTime - Math.floor(Date.now() / 1000);
          if (Math.abs(drift) >= MIN_CLOCK_DRIFT) {
            offset = Math.max(-MAX_CLOCK_DRIFT, Math.min(MAX_CLOCK_DRIFT, drift));
            continue;
          }
        }
        return {
          kind: 'failed',
          error: (cause) =>
            new EnigmossError(`The fallback API host answered with an error: ${failure.message}`, {
              code: failure.code,
              status,
              // The call's own request never left: only its earlier attempts decide the outcome.
              outcomeUnknown: cause.outcomeUnknown,
              requestId: failure.requestId,
              body: failure.body,
              cause,
            }),
        };
      }

      let parsed: unknown;
      const distrusted = (reason: string): Probe => ({
        kind: 'failed',
        error: (cause) =>
          new EnigmossError(`The fallback API host sent an answer the SDK does not trust: ${reason}`, {
            code: 'response.invalid',
            status,
            outcomeUnknown: cause.outcomeUnknown,
            requestId: response.headers.get('X-Request-Id'),
            body: parsed === undefined ? text : parsed,
            cause,
          }),
      });

      const stamp = response.headers.get('X-Response-Timestamp') ?? '';
      const mac = unhex(response.headers.get('X-Response-Signature') ?? '');
      if (!/^\d{1,12}$/.test(stamp) || mac === null || mac.length !== 32) {
        return distrusted('X-Response-Timestamp or X-Response-Signature is missing or malformed.');
      }
      if (Math.abs(Number(stamp) - (Math.floor(Date.now() / 1000) + offset)) > RESPONSE_TOLERANCE) {
        return distrusted(`X-Response-Timestamp is more than ${RESPONSE_TOLERANCE} s away from the local clock.`);
      }
      // hex(HMAC-SHA256(key, "{X-Response-Timestamp}\n{X-Signature of the request}\n{body}")), compared in constant time.
      if (!(await crypto.subtle.verify('HMAC', key, mac, concat(utf8(`${stamp}\n${signature}\n`), bytes)))) {
        return distrusted('X-Response-Signature does not match the key of the request.');
      }

      try {
        parsed = JSON.parse(text);
      } catch {
        return distrusted('the body is not valid JSON.');
      }
      const data = isObject(parsed) && isObject(parsed.data) ? parsed.data : {};
      const api = isObject(data.api) ? data.api : {};
      if (typeof api.origin !== 'string') {
        return distrusted('it has no data.api.origin.');
      }
      const origin = acceptOrigin(api.origin, (config.fallbackOrigin ?? '').startsWith('http://'));
      if (origin === null) {
        return distrusted('data.api.origin is not an https origin of a public host.');
      }
      return { kind: 'origin', origin, lifetime: originLifetime(data.refresh_after), body: parsed };
    }
  }

  private notify(change: OriginChange): void {
    const listener = this.config.onOriginChange;
    if (listener === undefined) {
      return;
    }
    try {
      // A listener never breaks an API call, an async one that rejects included.
      void Promise.resolve(listener(change)).catch(() => {});
    } catch {
      // Ignored for the same reason.
    }
  }

  private async attempt<T>(
    endpoint: Endpoint,
    origin: string,
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
      response = await send(`${origin}${requestUri}`, init);
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
    return { error: aborted(cause), delay: null };
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
  return { error, delay: retryable ? 'backoff' : null, unreachable: notSent };
}

/** An error response as the SDK reads it. */
interface ErrorBody {
  /** Parsed JSON, or the raw text when the body is not JSON. */
  readonly body: unknown;
  /** `error.code` of the API error body, else `http.<status>`. */
  readonly code: string;
  readonly hasEnvelope: boolean;
  readonly requestId: string | null;
  /** Seconds from `meta.retry_after` or the Retry-After header. */
  readonly retryAfter: number | null;
  readonly details: Record<string, unknown>;
  /** "<server message> [<code>, request <id>]". */
  readonly message: string;
}

function readError(response: Response, text: string): ErrorBody {
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
  return {
    body,
    code,
    hasEnvelope,
    requestId,
    retryAfter,
    details: isObject(error.details) ? error.details : {},
    message: `${message} [${code}${requestId === null ? '' : `, request ${requestId}`}]`,
  };
}

function errorResponse(retry: RetryClass, protectedByKey: boolean, response: Response, text: string): Failure {
  const status = response.status;
  const { body, code, hasEnvelope, requestId, retryAfter, message } = readError(response, text);
  const enigmossError = new EnigmossError(message, {
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
      reject(aborted(signal?.reason));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function aborted(cause: unknown): EnigmossError {
  return new EnigmossError('The request was aborted.', { code: 'aborted', outcomeUnknown: true, cause });
}

/** Waits for a result several calls share: an abort ends the caller's wait, not the shared work. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted(signal.reason));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
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
