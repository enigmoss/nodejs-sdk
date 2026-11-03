import { createHmac } from 'node:crypto';
import { Enigmoss, type EnigmossOptions } from '../src/index.js';

export const PROJECT = '3f2b8c1e-5d4a-4e7b-9c6f-1a2b3c4d5e6f';
export const PAYMENT_KEY = 'test-payment-secret';
export const PAYOUT_KEY = 'test-payout-secret';
export const ORIGIN = 'https://api.example.com';

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
