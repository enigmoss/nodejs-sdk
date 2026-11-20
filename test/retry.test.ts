import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Enigmoss, EnigmossError, type EnigmossOptions, type RequestOptions } from '../src/index.js';
import { apiError, client, fakeFetch, json, lostAfterSend, notSent, type Reply } from './helpers.js';

beforeEach(() => {
  // Zero jitter: backoff waits 0 ms, so the table runs fast.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Op = 'read' | 'quote' | 'money' | 'once';

const calls: Record<Op, (e: Enigmoss, o?: RequestOptions) => Promise<unknown>> = {
  read: (e, o) => e.payments.get('p-1', o),
  quote: (e, o) => e.payouts.quote({ amount: '1', currency_code: 'USDT', address: 'T1' }, o),
  money: (e, o) => e.payouts.create({ order_id: 'w-7', amount: '25', currency_code: 'USDT', address: 'T1' }, o),
  once: (e, o) => e.events.redeliver('e-1', o),
};

const ok = () => json(200, { data: { id: 'x' } });
const hang = 'hang' as const;

interface Case {
  op: Op;
  replies: () => Reply[];
  attempts: number;
  /** Expected error; omitted when the call succeeds. */
  error?: { code: string; outcomeUnknown: boolean };
}

const table: [string, Case][] = [
  // Reads: network, 429, 502–504.
  ['read: connection lost after send', { op: 'read', replies: () => [lostAfterSend(), ok()], attempts: 2 }],
  ['read: not sent', { op: 'read', replies: () => [notSent(), ok()], attempts: 2 }],
  ['read: timeout', { op: 'read', replies: () => [hang, ok()], attempts: 2 }],
  ['read: 429', { op: 'read', replies: () => [apiError(429, 'rate_limit.exceeded'), ok()], attempts: 2 }],
  ['read: 502 proxy page', { op: 'read', replies: () => [new Response('<html>', { status: 502 }), ok()], attempts: 2 }],
  ['read: 503', { op: 'read', replies: () => [apiError(503, 'dependency.unavailable'), ok()], attempts: 2 }],
  ['read: 504', { op: 'read', replies: () => [apiError(504, 'dependency.unavailable'), ok()], attempts: 2 }],
  [
    'read: 500 is not retried',
    {
      op: 'read',
      replies: () => [apiError(500, 'internal.server_error')],
      attempts: 1,
      error: { code: 'internal.server_error', outcomeUnknown: true },
    },
  ],
  [
    'read: 404 is not retried',
    {
      op: 'read',
      replies: () => [apiError(404, 'resource.not_found')],
      attempts: 1,
      error: { code: 'resource.not_found', outcomeUnknown: false },
    },
  ],
  [
    'read: gives up after maxRetries',
    {
      op: 'read',
      replies: () => [apiError(503, 'x'), apiError(503, 'x'), apiError(503, 'x'), ok()],
      attempts: 3,
      error: { code: 'x', outcomeUnknown: true },
    },
  ],
  [
    'quote: retried like a read',
    { op: 'quote', replies: () => [apiError(503, 'dependency.unavailable'), ok()], attempts: 2 },
  ],

  // Money POSTs with the derived Idempotency-Key.
  ['money: not sent', { op: 'money', replies: () => [notSent(), ok()], attempts: 2 }],
  ['money: lost after send, key protects', { op: 'money', replies: () => [lostAfterSend(), ok()], attempts: 2 }],
  ['money: timeout, key protects', { op: 'money', replies: () => [hang, ok()], attempts: 2 }],
  [
    'money: rate_limit.exceeded',
    { op: 'money', replies: () => [apiError(429, 'rate_limit.exceeded'), ok()], attempts: 2 },
  ],
  ['money: lock.not_acquired', { op: 'money', replies: () => [apiError(409, 'lock.not_acquired'), ok()], attempts: 2 }],
  [
    'money: dependency.unavailable',
    { op: 'money', replies: () => [apiError(503, 'dependency.unavailable'), ok()], attempts: 2 },
  ],
  [
    'money: idempotency.in_progress until retries run out',
    {
      op: 'money',
      replies: () => [1, 2, 3].map(() => apiError(409, 'idempotency.in_progress')),
      attempts: 3,
      error: { code: 'idempotency.in_progress', outcomeUnknown: true },
    },
  ],
  [
    'money: business error never retried',
    {
      op: 'money',
      replies: () => [apiError(422, 'payout.insufficient_funds')],
      attempts: 1,
      error: { code: 'payout.insufficient_funds', outcomeUnknown: false },
    },
  ],
  [
    'money: business dependency error never retried',
    {
      op: 'money',
      replies: () => [apiError(502, 'dependency.gateway')],
      attempts: 1,
      error: { code: 'dependency.gateway', outcomeUnknown: true },
    },
  ],
  [
    'money: 500 never retried',
    {
      op: 'money',
      replies: () => [apiError(500, 'internal.unexpected')],
      attempts: 1,
      error: { code: 'internal.unexpected', outcomeUnknown: true },
    },
  ],
  [
    'money: validation error never retried',
    {
      op: 'money',
      replies: () => [apiError(422, 'validation.failed')],
      attempts: 1,
      error: { code: 'validation.failed', outcomeUnknown: false },
    },
  ],
  [
    'money: an earlier unknown outcome sticks to a later "not executed" error',
    {
      op: 'money',
      replies: () => [lostAfterSend(), apiError(429, 'rate_limit.exceeded', { retry_after: 60 })],
      attempts: 2,
      error: { code: 'rate_limit.exceeded', outcomeUnknown: true },
    },
  ],

  // Redelivery and the test webhook: only when nothing was sent.
  ['once: not sent', { op: 'once', replies: () => [notSent(), ok()], attempts: 2 }],
  [
    'once: lost after send',
    { op: 'once', replies: () => [lostAfterSend()], attempts: 1, error: { code: 'network', outcomeUnknown: true } },
  ],
  [
    'once: timeout',
    { op: 'once', replies: () => [hang], attempts: 1, error: { code: 'timeout', outcomeUnknown: true } },
  ],
  [
    'once: 503',
    {
      op: 'once',
      replies: () => [apiError(503, 'dependency.unavailable')],
      attempts: 1,
      error: { code: 'dependency.unavailable', outcomeUnknown: true },
    },
  ],
  [
    'once: 429',
    {
      op: 'once',
      replies: () => [apiError(429, 'rate_limit.exceeded')],
      attempts: 1,
      error: { code: 'rate_limit.exceeded', outcomeUnknown: false },
    },
  ],
];

async function run(op: Op, replies: Reply[], options: Partial<EnigmossOptions> = {}) {
  const { fetch, sent } = fakeFetch(replies);
  // A short per-call timeout: it also overrides the 180 s floor of payout creation.
  const result = await calls[op](client(fetch, options), { timeout: 50 }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { sent, result };
}

describe('retry rules', () => {
  it.each(table)('%s', async (_, c) => {
    const { sent, result } = await run(c.op, c.replies());
    expect(sent).toHaveLength(c.attempts);
    if (c.error === undefined) {
      expect(result).toEqual({ value: { data: { id: 'x' } } });
    } else {
      expect('error' in result && result.error).toBeInstanceOf(EnigmossError);
      expect('error' in result && result.error).toMatchObject(c.error);
    }
  });

  it('sends the same body and Idempotency-Key on every attempt', async () => {
    const { sent } = await run('money', [lostAfterSend(), apiError(409, 'lock.not_acquired'), ok()]);
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((s) => s.body)).size).toBe(1);
    expect(new Set(sent.map((s) => s.headers['Idempotency-Key'])).size).toBe(1);
    expect(sent[0]?.headers['Idempotency-Key']).toMatch(/^sdk1-[0-9a-f]{59}$/);
  });

  it('waits Retry-After seconds when it is at most 10', async () => {
    const started = Date.now();
    const { sent } = await run('read', [apiError(429, 'rate_limit.exceeded', { retry_after: 1 }), ok()]);
    expect(sent).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it('reads Retry-After from the header of a proxy response', async () => {
    const { sent, result } = await run('read', [
      new Response('busy', { status: 429, headers: { 'Retry-After': '11' } }),
    ]);
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ error: { code: 'http.429', status: 429, body: 'busy' } });
  });

  it('does not retry when Retry-After is above 10 seconds', async () => {
    const { sent, result } = await run('money', [apiError(429, 'rate_limit.exceeded', { retry_after: 30 })]);
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ error: { code: 'rate_limit.exceeded', outcomeUnknown: false, requestId: 'req-1' } });
  });

  it('does not retry a 2xx with a broken body and reports an unknown outcome', async () => {
    const { sent, result } = await run('money', [new Response('<html>', { status: 201 })]);
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ error: { code: 'response.invalid', status: 201, outcomeUnknown: true } });
  });
});

describe('maxRetries', () => {
  it('0 on the client disables retries', async () => {
    const { sent, result } = await run('read', [apiError(503, 'dependency.unavailable'), ok()], { maxRetries: 0 });
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ error: { code: 'dependency.unavailable', status: 503 } });
  });

  it('0 on the client disables retries of money POSTs too', async () => {
    const { sent } = await run('money', [notSent(), ok()], { maxRetries: 0 });
    expect(sent).toHaveLength(1);
  });

  it('0 per call overrides the client', async () => {
    const { fetch, sent } = fakeFetch([apiError(503, 'x'), ok()]);
    await expect(client(fetch).payments.get('p-1', { maxRetries: 0 })).rejects.toThrow(EnigmossError);
    expect(sent).toHaveLength(1);
  });

  it('per call raises the client value', async () => {
    const { fetch, sent } = fakeFetch([apiError(503, 'x'), apiError(503, 'x'), ok()]);
    await client(fetch, { maxRetries: 0 }).payments.get('p-1', { maxRetries: 5 });
    expect(sent).toHaveLength(3);
  });
});

describe('idempotency: false', () => {
  it('sends a random key where the server requires one and never retries a sent money POST', async () => {
    const { sent, result } = await run('money', [lostAfterSend(), ok()], { idempotency: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result).toMatchObject({ error: { code: 'network', outcomeUnknown: true } });
  });

  it('does not retry "not executed" answers of a sent money POST', async () => {
    const { sent } = await run('money', [apiError(409, 'lock.not_acquired'), ok()], { idempotency: false });
    expect(sent).toHaveLength(1);
  });

  it('still retries a money POST that was not sent, with the same key', async () => {
    const { sent } = await run('money', [notSent(), ok()], { idempotency: false });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.headers['Idempotency-Key']).toBe(sent[1]?.headers['Idempotency-Key']);
  });

  it('sends no key where the server only supports one', async () => {
    const { fetch, sent } = fakeFetch();
    const enigmoss = client(fetch, { idempotency: false });
    await enigmoss.payments.create({ amount: '1', currency_code: 'USDT', order_id: 'o-1' });
    await enigmoss.payments.cancel('p-1');
    expect(sent.map((s) => s.headers['Idempotency-Key'])).toEqual([undefined, undefined]);
  });

  it('an explicit key still protects the call', async () => {
    const { fetch, sent } = fakeFetch([lostAfterSend(), ok()]);
    await client(fetch, { idempotency: false }).payouts.create(
      { order_id: 'w-7', amount: '25', currency_code: 'USDT', address: 'T1' },
      { idempotencyKey: 'my-key' },
    );
    expect(sent.map((s) => s.headers['Idempotency-Key'])).toEqual(['my-key', 'my-key']);
  });
});

describe('Idempotency-Key with idempotency: true', () => {
  it('derives the key of a create from order_id, the same as the PHP SDK', async () => {
    const { fetch, sent } = fakeFetch();
    await client(fetch).payouts.create({ order_id: 'w-7', amount: '25', currency_code: 'USDT', address: 'T1' });
    expect(sent[0]?.headers['Idempotency-Key']).toBe(
      'sdk1-cb63fbc5a317a1bbe87ab542f5980a1a048b5b60f3c49a0de8654500566',
    );
  });

  it('uses a random key per call for other POST actions', async () => {
    const { fetch, sent } = fakeFetch();
    const enigmoss = client(fetch);
    await enigmoss.payments.cancel('p-1');
    await enigmoss.payments.cancel('p-1');
    const [a, b] = sent.map((s) => s.headers['Idempotency-Key']);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it('sends no key on reads, quotes and redeliveries', async () => {
    const { fetch, sent } = fakeFetch();
    const enigmoss = client(fetch);
    await enigmoss.payments.get('p-1');
    await calls.quote(enigmoss);
    await enigmoss.events.redeliver('e-1');
    expect(sent.map((s) => s.headers['Idempotency-Key'])).toEqual([undefined, undefined, undefined]);
  });

  it('an explicit key wins over the derived one', async () => {
    const { fetch, sent } = fakeFetch();
    await client(fetch).payments.create(
      { amount: '1', currency_code: 'USDT', order_id: 'o-1' },
      { idempotencyKey: 'mine' },
    );
    expect(sent[0]?.headers['Idempotency-Key']).toBe('mine');
  });
});

describe('timeouts and abort', () => {
  it('payout and refund creation get at least 180 s', async () => {
    const timeouts: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      timeouts.push(ms);
      return original(ms);
    });
    const { fetch } = fakeFetch();
    const enigmoss = client(fetch);
    await enigmoss.payouts.create({ order_id: 'w-7', amount: '25', currency_code: 'USDT', address: 'T1' });
    await enigmoss.refunds.createForPayment('p-1', { order_id: 'r-1', address: 'T1' });
    await enigmoss.refunds.createForWallet('w-1', { order_id: 'r-2', address: 'T1' });
    await enigmoss.payments.get('p-1');
    await enigmoss.payouts.create(
      { order_id: 'w-8', amount: '1', currency_code: 'USDT', address: 'T1' },
      { timeout: 5 },
    );
    expect(timeouts).toEqual([180_000, 180_000, 180_000, 30_000, 5]);
  });

  it('an aborted signal stops the call with an unknown outcome', async () => {
    const { fetch, sent } = fakeFetch([hang]);
    const controller = new AbortController();
    const enigmoss = client((input, init) => {
      const response = fetch(input, init);
      // The fake transport records the request and registers its abort listener synchronously.
      controller.abort();
      return response;
    });
    const promise = enigmoss.payouts.create(
      { order_id: 'w-7', amount: '25', currency_code: 'USDT', address: 'T1' },
      { signal: controller.signal },
    );
    await expect(promise).rejects.toMatchObject({ code: 'aborted', outcomeUnknown: true });
    expect(sent).toHaveLength(1);
  });
});
