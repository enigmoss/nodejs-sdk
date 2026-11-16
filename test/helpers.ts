import { createHmac } from 'node:crypto';
import { Enigmoss, type EnigmossOptions } from '../src/index.js';

export const PROJECT = '3f2b8c1e-5d4a-4e7b-9c6f-1a2b3c4d5e6f';
export const PAYMENT_KEY = 'test-payment-secret';
export const PAYOUT_KEY = 'test-payout-secret';
export const ORIGIN = 'https://api.example.com';
/** The fallback host of the fallback tests and the origin it names. */
export const FALLBACK = 'https://api.example.org';
export const MOVED = 'https://api2.example.com';
export const PROBE_URI = '/api/v4/project/platform-brand';

export interface Sent {
  readonly method: string;
  readonly url: string;
  readonly uri: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

/** A scripted reply: a Response, an error to throw, or `'hang'` to wait until the request is aborted. */
export type Reply = Response | Error | 'hang';

/** A fetch that records every request and answers with the scripted replies, then with `fallback`. */
export function fakeFetch(replies: Reply[] = [], fallback: () => Response = () => json(200, { data: {} })) {
  const sent: Sent[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body == null ? null : new TextDecoder().decode(init.body as Uint8Array);
    sent.push({
      method: init?.method ?? 'GET',
      url,
      uri: url.slice(ORIGIN.length),
      headers: { ...(init?.headers as Record<string, string>) },
      body,
    });
    const reply = replies.shift() ?? fallback();
    if (reply === 'hang') {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

/** Answers of one host: a function of the request, or scripted replies in order (the last one repeats). */
export type Host = Reply[] | ((request: Sent) => Reply | Promise<Reply>);

/** A fetch that serves several hosts, keyed by origin, and records every request. An unknown host fails the test. */
export function fakeHosts(hosts: Record<string, Host>) {
  const sent: Sent[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const request: Sent = {
      method: init?.method ?? 'GET',
      url: String(input),
      uri: url.pathname + url.search,
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body == null ? null : new TextDecoder().decode(init.body as Uint8Array),
    };
    sent.push(request);
    const host = hosts[url.origin];
    if (host === undefined) {
      throw new Error(`unexpected request to ${url.origin}`);
    }
    let reply: Reply | undefined;
    if (typeof host === 'function') {
      reply = await host(request);
    } else if (host.length > 1) {
      reply = host.shift();
    } else {
      // The last scripted reply repeats; a Response can be read only once.
      reply = host[0] instanceof Response ? host[0].clone() : host[0];
    }
    if (reply === undefined) {
      throw new Error(`no reply scripted for ${url.origin}`);
    }
    if (reply === 'hang') {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
  /** Requests one host received. */
  const to = (origin: string) => sent.filter((request) => request.url.startsWith(`${origin}/`));
  return { fetch: fetch as typeof globalThis.fetch, sent, to };
}

export interface BrandOptions {
  /** Key the response is signed with; the payment key by default. */
  key?: string;
  /** `refresh_after` of the body; omitted from the body when `null`. */
  refreshAfter?: unknown;
  /** X-Response-Timestamp; the current time by default. */
  timestamp?: number;
  /** Replaces `data` of the body. */
  data?: unknown;
  /** Replaces the whole body text (still signed). */
  text?: string;
  /** Drops the X-Response-* headers. */
  unsigned?: boolean;
}

/**
 * The platform-brand answer of a fallback host naming `origin` as the API origin, signed for
 * `request` by an independent implementation of the response signature (node:crypto).
 */
export function brand(request: Sent, origin: unknown, options: BrandOptions = {}): Response {
  const data = options.data ?? {
    brand: null,
    payform: { origin: 'https://pay.example.com' },
    api: { origin },
    ...(options.refreshAfter === null ? {} : { refresh_after: options.refreshAfter ?? 86_400 }),
  };
  const text = options.text ?? JSON.stringify({ data, meta: { request_id: 'req-brand' } });
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!options.unsigned) {
    headers['X-Response-Timestamp'] = timestamp;
    headers['X-Response-Signature'] = createHmac('sha256', options.key ?? PAYMENT_KEY)
      .update(`${timestamp}\n${request.headers['X-Signature']}\n${text}`)
      .digest('hex');
  }
  return new Response(text, { status: 200, headers });
}

export function client(fetch: typeof globalThis.fetch, options: Partial<EnigmossOptions> = {}): Enigmoss {
  return new Enigmoss({
    baseUrl: ORIGIN,
    projectId: PROJECT,
    paymentKey: PAYMENT_KEY,
    payoutKey: PAYOUT_KEY,
    fetch,
    ...options,
  });
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function apiError(status: number, code: string, meta: Record<string, unknown> = {}): Response {
  return json(status, {
    error: { code, type: 'error', message: `Error ${code}.` },
    meta: { request_id: 'req-1', ...meta },
  });
}

/** fetch failure before anything was sent (connection refused). */
export function notSent(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
  });
}

/** fetch failure after the request may have been sent (connection reset). */
export function lostAfterSend(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
  });
}

/** Independent reference implementation of the request signature, on node:crypto. */
export function expectedSignature(
  key: string,
  headers: Record<string, string>,
  method: string,
  uri: string,
  body: string,
) {
  return createHmac('sha256', key)
    .update(`${headers['X-Timestamp']}\n${headers['X-Project-Uuid']}\n${method}\n${uri}\n${body}`)
    .digest('hex');
}
