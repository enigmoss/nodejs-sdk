import { createHmac } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Enigmoss, EnigmossError, type EnigmossOptions, type OriginChange } from '../src/index.js';
import {
  apiError,
  type BrandOptions,
  brand,
  client,
  expectedSignature,
  FALLBACK,
  fakeHosts,
  type Host,
  json,
  lostAfterSend,
  MOVED,
  nonce,
  notSent,
  ORIGIN,
  PAYMENT_KEY,
  PAYOUT_KEY,
  PROBE,
  PROBE_URI,
  PROJECT,
  type Reply,
  type Sent,
} from './helpers.js';

beforeEach(() => {
  // Zero jitter: backoff waits 0 ms.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PAYOUT = { order_id: 'w-7', amount: '25', currency_code: 'USDT', address: 'T1' };
const ok = () => json(200, { data: { id: 'x' } });
const down: Host = () => notSent();
const names = (origin: unknown, options?: BrandOptions): Host => {
  return (request) => brand(request, origin, options);
};

function setup(hosts: Record<string, Host>, options: Partial<EnigmossOptions> = {}) {
  const net = fakeHosts(hosts);
  const changes: OriginChange[] = [];
  const enigmoss = client(net.fetch, {
    fallbackBaseUrl: FALLBACK,
    onOriginChange: (change) => changes.push(change),
    ...options,
  });
  return { ...net, enigmoss, changes };
}

const fails = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('the call did not fail');
    },
    (error: unknown) => error as EnigmossError,
  );

describe('when the API host cannot be reached', () => {
  it('a retry that reaches it needs no fallback', async () => {
    const { enigmoss, to } = setup({ [ORIGIN]: [notSent(), ok()], [FALLBACK]: names(MOVED) });
    await expect(enigmoss.payments.get('p-1')).resolves.toEqual({ data: { id: 'x' } });
    expect(to(ORIGIN)).toHaveLength(2);
    expect(to(FALLBACK)).toHaveLength(0);
  });

  it('asks the fallback host after the retries and repeats the call on the origin it names', async () => {
    const { enigmoss, sent, to, changes } = setup({
      [ORIGIN]: down,
      [FALLBACK]: names(MOVED, { refreshAfter: 7_200 }),
      [MOVED]: () => ok(),
    });
    const before = Date.now();
    await expect(enigmoss.payments.get('p-1')).resolves.toEqual({ data: { id: 'x' } });

    expect(sent.map((request) => request.url)).toEqual([
      `${ORIGIN}/api/v4/payments/p-1`,
      `${ORIGIN}/api/v4/payments/p-1`,
      `${ORIGIN}/api/v4/payments/p-1`,
      `${FALLBACK}${PROBE_URI}?nonce=${nonce(sent[3] as Sent)}`,
      `${MOVED}/api/v4/payments/p-1`,
    ]);

    // The new origin is remembered: the next call goes straight to it.
    await enigmoss.payments.get('p-2');
    expect(to(ORIGIN)).toHaveLength(3);
    expect(to(FALLBACK)).toHaveLength(1);
    expect(to(MOVED).map((request) => request.uri)).toEqual(['/api/v4/payments/p-1', '/api/v4/payments/p-2']);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ previous: ORIGIN, current: MOVED });
    const lifetime = (changes[0] as OriginChange).expiresAt.getTime() - before;
    expect(lifetime).toBeGreaterThanOrEqual(7_200_000);
    expect(lifetime).toBeLessThan(7_205_000);
  });

  it('signs the probe like any request and sends nothing else with it', async () => {
    const { enigmoss, to } = setup({ [ORIGIN]: down, [FALLBACK]: names(MOVED), [MOVED]: () => ok() });
    await enigmoss.payouts.create(PAYOUT);
    const probe = to(FALLBACK)[0] as Sent;
    expect(probe).toMatchObject({ method: 'GET', body: null });
    // A one-time nonce is the whole query, and it is signed with the path.
    expect(probe.uri).toMatch(PROBE);
    expect(Object.keys(probe.headers).sort()).toEqual([
      'Accept',
      'User-Agent',
      'X-Project-Uuid',
      'X-Signature',
      'X-Timestamp',
    ]);
    expect(probe.headers['X-Project-Uuid']).toBe(PROJECT);
    // Either key reads the platform brand: the payment key when both are set.
    expect(probe.headers['X-Signature']).toBe(expectedSignature(PAYMENT_KEY, probe.headers, 'GET', probe.uri, ''));
    expect(probe.headers['X-Signature']).not.toBe(expectedSignature(PAYMENT_KEY, probe.headers, 'GET', PROBE_URI, ''));
  });

  it('signs the probe with the payout key when it is the only one', async () => {
    const { enigmoss, to } = setup(
      { [ORIGIN]: down, [FALLBACK]: names(MOVED, { key: PAYOUT_KEY }), [MOVED]: () => ok() },
      { paymentKey: undefined },
    );
    await enigmoss.payouts.create(PAYOUT);
    const probe = to(FALLBACK)[0] as Sent;
    expect(probe.headers['X-Signature']).toBe(expectedSignature(PAYOUT_KEY, probe.headers, 'GET', probe.uri, ''));
    expect(to(MOVED)).toHaveLength(1);
  });

  it('repeats a money POST with the same body and Idempotency-Key, signed again', async () => {
    const { enigmoss, to } = setup({
      [ORIGIN]: down,
      [FALLBACK]: names(MOVED),
      // The attempts start over on the new origin.
      [MOVED]: [apiError(503, 'dependency.unavailable'), apiError(503, 'dependency.unavailable'), ok()],
    });
    await expect(enigmoss.payouts.create(PAYOUT)).resolves.toEqual({ data: { id: 'x' } });

    const requests = [...to(ORIGIN), ...to(MOVED)];
    expect(to(ORIGIN)).toHaveLength(3);
    expect(to(MOVED)).toHaveLength(3);
    expect(new Set(requests.map((request) => request.body)).size).toBe(1);
    expect(new Set(requests.map((request) => request.headers['Idempotency-Key'])).size).toBe(1);
    expect(requests[0]?.headers['Idempotency-Key']).toMatch(/^sdk1-[0-9a-f]{59}$/);
    for (const request of to(MOVED)) {
      expect(request.headers['X-Signature']).toBe(
        expectedSignature(PAYOUT_KEY, request.headers, 'POST', '/api/v4/payouts', request.body ?? ''),
      );
    }
  });

  it('accepts an answer signed up to 300 s away from the local clock', async () => {
    for (const shift of [-295, 295]) {
      const { enigmoss, to } = setup({
        [ORIGIN]: down,
        [FALLBACK]: names(MOVED, { timestamp: Math.floor(Date.now() / 1000) + shift }),
        [MOVED]: () => ok(),
      });
      await enigmoss.payments.get('p-1');
      expect(to(MOVED)).toHaveLength(1);
    }
  });

  it('normalizes the origin it is given', async () => {
    const { enigmoss, to, changes } = setup({
      [ORIGIN]: down,
      [FALLBACK]: names('HTTPS://API2.Example.COM:443'),
      [MOVED]: () => ok(),
    });
    await enigmoss.payments.get('p-1');
    expect(to(MOVED)[0]?.url).toBe(`${MOVED}/api/v4/payments/p-1`);
    expect(changes[0]?.current).toBe(MOVED);
  });

  it('falls back once per call: a new origin that is down too fails the call', async () => {
    const { enigmoss, to, changes } = setup({ [ORIGIN]: down, [FALLBACK]: names(MOVED), [MOVED]: down });
    const error = await fails(enigmoss.payments.get('p-1'));
    expect(error).toMatchObject({ code: 'network', outcomeUnknown: false });
    expect(to(ORIGIN)).toHaveLength(3);
    expect(to(FALLBACK)).toHaveLength(1);
    expect(to(MOVED)).toHaveLength(3);
    expect(changes).toHaveLength(1);
  });

  it('works without onOriginChange and survives a listener that throws or rejects', async () => {
    for (const onOriginChange of [
      undefined,
      () => {
        throw new Error('listener failed');
      },
      (async () => {
        throw new Error('listener rejected');
      }) as unknown as () => void,
    ]) {
      const net = fakeHosts({ [ORIGIN]: down, [FALLBACK]: names(MOVED), [MOVED]: () => ok() });
      const enigmoss = client(net.fetch, { fallbackBaseUrl: FALLBACK, onOriginChange });
      await expect(enigmoss.payments.get('p-1')).resolves.toEqual({ data: { id: 'x' } });
      expect(net.to(MOVED)).toHaveLength(1);
    }
  });
});

describe('an answer of the fallback host that is not a new origin', () => {
  const now = () => Math.floor(Date.now() / 1000);
  const page = (status: number, headers: Record<string, string> = {}) => new Response('<html>', { status, headers });

  const failures: [string, Host, { code: string; status: number }][] = [
    ['401', () => apiError(401, 'auth.signature_invalid'), { code: 'auth.signature_invalid', status: 401 }],
    ['403', () => apiError(403, 'auth.ip_forbidden'), { code: 'auth.ip_forbidden', status: 403 }],
    ['404', () => apiError(404, 'resource.not_found'), { code: 'resource.not_found', status: 404 }],
    ['404 without the API error body', () => page(404), { code: 'http.404', status: 404 }],
    ['429', () => apiError(429, 'rate_limit.exceeded'), { code: 'rate_limit.exceeded', status: 429 }],
    ['500', () => apiError(500, 'internal.server_error'), { code: 'internal.server_error', status: 500 }],
    ['503', () => apiError(503, 'dependency.unavailable'), { code: 'dependency.unavailable', status: 503 }],
    ['502 proxy page', () => page(502), { code: 'http.502', status: 502 }],
    ['a redirect', () => page(302, { Location: `${MOVED}${PROBE_URI}` }), { code: 'http.302', status: 302 }],
    ['200 without api', names(MOVED, { data: { brand: null, refresh_after: 86_400 } }), invalid()],
    ['200 with api.origin of another type', names(42), invalid()],
    ['200 that is not JSON', names(MOVED, { text: '<html>' }), invalid()],
    ['no signature headers', names(MOVED, { unsigned: true }), invalid()],
    ['a signature of another key', names(MOVED, { key: 'another-secret' }), invalid()],
    [
      'a signature of another request',
      (request) => brand({ ...request, headers: { 'X-Signature': 'ab'.repeat(32) } }, MOVED),
      invalid(),
    ],
    [
      'a body changed after signing',
      async (request) => {
        const signed = brand(request, MOVED);
        return new Response((await signed.text()).replace('api2.', 'api3.'), { status: 200, headers: signed.headers });
      },
      invalid(),
    ],
    ['a timestamp older than 300 s', names(MOVED, { timestamp: now() - 302 }), invalid()],
    ['a timestamp more than 300 s ahead', names(MOVED, { timestamp: now() + 302 }), invalid()],
    ...[
      'http://api2.example.com',
      'http://localhost:8080',
      'https://10.0.0.5',
      'https://[::1]',
      'https://localhost',
      'https://printer.local',
      'https://app.localhost',
      'https://example',
      'https://api2.example.123',
      'https://api2.example.com:8443',
      'https://api2.example.com/',
      'https://api2.example.com/api/v4',
      'https://user:pass@api2.example.com',
      'https://api2.example.com?x=1',
      'https://api2.example.com#top',
      'https://api2.example.com.',
      ' https://api2.example.com',
      'https://api2.example.com ',
      'https://api2.example.com\n',
      'https://api2.example.com\r\n',
      'https://api2.example.com\u2028',
      '\nhttps://api2.example.com',
      'https://api2.example.com\nhttps://api3.example.com',
      'https://api2.example.com:443\n',
      'https://api2.example.com\u0000',
      'https://api2 .example.com',
      'ftp://api2.example.com',
      '//api2.example.com',
      '',
    ].map((origin): [string, Host, { code: string; status: number }] => [
      `the origin ${JSON.stringify(origin)}`,
      names(origin),
      invalid(),
    ]),
  ];

  function invalid() {
    return { code: 'response.invalid', status: 200 };
  }

  it.each(failures)(
    '%s: its error is thrown, the network error is the cause, nothing is remembered',
    async (...row) => {
      const [, host, expected] = row;
      const { enigmoss, to, changes } = setup({ [ORIGIN]: down, [FALLBACK]: host, [MOVED]: () => ok() });

      const error = await fails(enigmoss.payouts.create(PAYOUT));
      expect(error).toBeInstanceOf(EnigmossError);
      // The payout request never left: the status of the fallback host says nothing about its outcome.
      expect(error).toMatchObject({ ...expected, outcomeUnknown: false });
      expect(error.message).toContain('fallback API host');
      expect(error.cause).toBeInstanceOf(EnigmossError);
      expect(error.cause).toMatchObject({ code: 'network', outcomeUnknown: false, status: null });
      expect(to(FALLBACK)).toHaveLength(1);
      expect(to(MOVED)).toHaveLength(0);
      expect(changes).toHaveLength(0);

      // Nothing was remembered but the time: the next call fails with its own error, without a probe.
      const next = await fails(enigmoss.payments.get('p-1'));
      expect(next).toMatchObject({ code: 'network', outcomeUnknown: false });
      expect(next.cause).not.toBeInstanceOf(EnigmossError);
      expect(to(ORIGIN)).toHaveLength(6);
      expect(to(FALLBACK)).toHaveLength(1);
      expect(to(MOVED)).toHaveLength(0);
    },
  );

  it('carries the answer of the fallback host', async () => {
    const { enigmoss } = setup({ [ORIGIN]: down, [FALLBACK]: () => apiError(404, 'resource.not_found') });
    const error = await fails(enigmoss.payments.get('p-1'));
    expect(error.message).toBe(
      'The fallback API host answered with an error: Error resource.not_found. [resource.not_found, request req-1]',
    );
    expect(error).toMatchObject({ requestId: 'req-1', body: { error: { code: 'resource.not_found' } } });
  });

  it('the same origin: the network error of the call is thrown', async () => {
    const { enigmoss, to, changes } = setup({ [ORIGIN]: down, [FALLBACK]: names(ORIGIN) });
    const error = await fails(enigmoss.payouts.create(PAYOUT));
    expect(error).toMatchObject({ code: 'network', outcomeUnknown: false, status: null });
    expect(error.message).toBe('Cannot connect to the API host; the request was not sent.');
    expect(changes).toHaveLength(0);

    await fails(enigmoss.payments.get('p-1'));
    expect(to(FALLBACK)).toHaveLength(1);
  });

  it.each<[string, () => Reply]>([
    ['refuses the connection', () => notSent()],
    ['drops the connection', () => lostAfterSend()],
  ])('the fallback host %s: the network error of the call is thrown', async (_, reply) => {
    const { enigmoss, to, changes } = setup({ [ORIGIN]: down, [FALLBACK]: reply });
    const error = await fails(enigmoss.payouts.create(PAYOUT));
    expect(error).toMatchObject({ code: 'network', outcomeUnknown: false, status: null });
    expect(error.message).toBe('Cannot connect to the API host; the request was not sent.');
    expect(changes).toHaveLength(0);

    await fails(enigmoss.payments.get('p-1'));
    expect(to(FALLBACK)).toHaveLength(1);
  });

  it('an earlier attempt that may have run keeps the outcome unknown', async () => {
    const { enigmoss } = setup({
      [ORIGIN]: [lostAfterSend(), notSent()],
      [FALLBACK]: () => apiError(404, 'resource.not_found'),
    });
    const error = await fails(enigmoss.payouts.create(PAYOUT));
    expect(error).toMatchObject({ code: 'resource.not_found', outcomeUnknown: true });
    expect(error.cause).toMatchObject({ code: 'network', outcomeUnknown: true });
  });

  it('tries again after the pause of 5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { enigmoss, to } = setup({
      [ORIGIN]: down,
      [FALLBACK]: [apiError(503, 'dependency.unavailable'), page(404)],
    });
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'dependency.unavailable' });

    vi.setSystemTime(Date.now() + 299_999);
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'network' });
    expect(to(FALLBACK)).toHaveLength(1);

    vi.setSystemTime(Date.now() + 1);
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'http.404' });
    expect(to(FALLBACK)).toHaveLength(2);
  });

  it('a new origin ends the pause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { enigmoss, to, changes } = setup({
      [ORIGIN]: down,
      [FALLBACK]: (request) => (to(FALLBACK).length === 1 ? page(404) : brand(request, MOVED)),
      [MOVED]: [ok(), notSent()],
    });
    await fails(enigmoss.payments.get('p-1'));
    vi.setSystemTime(Date.now() + 300_000);
    await enigmoss.payments.get('p-1');
    expect(changes).toHaveLength(1);

    // The new origin stops answering right away: the probe is not held back by the old pause.
    await fails(enigmoss.payments.get('p-1'));
    expect(to(FALLBACK)).toHaveLength(3);
  });
});

describe('the remembered origin', () => {
  it.each<[string, unknown, number]>([
    ['is kept for refresh_after seconds', 7_200, 7_200],
    ['is kept for at least an hour', 60, 3_600],
    ['is kept for at most 7 days', 10_000_000, 604_800],
    ['is kept for an hour when refresh_after is missing', null, 3_600],
    ['is kept for an hour when refresh_after is not an integer', '86400', 3_600],
  ])('%s, then the client returns to baseUrl', async (_, refreshAfter, seconds) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { enigmoss, to, changes } = setup({
      [ORIGIN]: [notSent(), notSent(), notSent(), ok()],
      [FALLBACK]: names(MOVED, { refreshAfter }),
      [MOVED]: () => ok(),
    });
    const start = Date.now();
    await enigmoss.payments.get('p-1');
    expect(changes[0]?.expiresAt.getTime()).toBe(start + seconds * 1000);

    vi.setSystemTime(start + seconds * 1000 - 1);
    await enigmoss.payments.get('p-2');
    expect(to(MOVED)).toHaveLength(2);
    expect(to(ORIGIN)).toHaveLength(3);

    vi.setSystemTime(start + seconds * 1000);
    await enigmoss.payments.get('p-3');
    expect(to(MOVED)).toHaveLength(2);
    expect(to(ORIGIN)).toHaveLength(4);
    expect(to(FALLBACK)).toHaveLength(1);
  });

  it('is replaced when it stops answering and the fallback host names another one', async () => {
    const third = 'https://api3.example.com';
    let named = MOVED;
    const { enigmoss, to, changes } = setup({
      [ORIGIN]: down,
      [FALLBACK]: (request) => brand(request, named),
      [MOVED]: [ok(), notSent()],
      [third]: () => ok(),
    });
    await enigmoss.payments.get('p-1');
    named = third;
    await enigmoss.payments.get('p-2');
    expect(to(MOVED)).toHaveLength(4);
    expect(to(third)).toHaveLength(1);
    expect(changes.map((change) => [change.previous, change.current])).toEqual([
      [ORIGIN, MOVED],
      [MOVED, third],
    ]);
  });

  it('stays when the fallback host names it again: the call fails with its network error', async () => {
    const { enigmoss, to, changes } = setup({ [ORIGIN]: down, [FALLBACK]: names(MOVED), [MOVED]: [ok(), notSent()] });
    await enigmoss.payments.get('p-1');
    expect(await fails(enigmoss.payments.get('p-2'))).toMatchObject({ code: 'network' });
    expect(to(FALLBACK)).toHaveLength(2);
    expect(changes).toHaveLength(1);
  });
});

describe('the fallback is not started', () => {
  it('without fallbackBaseUrl', async () => {
    for (const fallbackBaseUrl of [undefined, '', '  ']) {
      const { enigmoss, sent } = setup({ [ORIGIN]: down }, { fallbackBaseUrl });
      expect(await fails(enigmoss.payouts.create(PAYOUT))).toMatchObject({ code: 'network', outcomeUnknown: false });
      expect(sent).toHaveLength(3);
    }
  });

  it('by a timeout', async () => {
    const { enigmoss, to } = setup({ [ORIGIN]: () => 'hang', [FALLBACK]: names(MOVED) });
    expect(await fails(enigmoss.payments.get('p-1', { timeout: 30 }))).toMatchObject({ code: 'timeout' });
    expect(to(ORIGIN)).toHaveLength(3);
    expect(to(FALLBACK)).toHaveLength(0);
  });

  it('by a connection lost after the request was sent', async () => {
    const { enigmoss, to } = setup({ [ORIGIN]: () => lostAfterSend(), [FALLBACK]: names(MOVED) });
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'network', outcomeUnknown: true });
    expect(to(FALLBACK)).toHaveLength(0);
  });

  it('by a network error without a code', async () => {
    const { enigmoss, to } = setup({ [ORIGIN]: () => new TypeError('Failed to fetch'), [FALLBACK]: names(MOVED) });
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'network', outcomeUnknown: true });
    expect(to(FALLBACK)).toHaveLength(0);
  });

  it('by an error response of the API host', async () => {
    const { enigmoss, to } = setup({
      [ORIGIN]: [notSent(), apiError(503, 'dependency.unavailable')],
      [FALLBACK]: names(MOVED),
    });
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'dependency.unavailable' });
    expect(to(FALLBACK)).toHaveLength(0);
  });

  it('for an aborted call', async () => {
    const controller = new AbortController();
    const { enigmoss, to } = setup({
      [ORIGIN]: () => {
        controller.abort();
        return notSent();
      },
      [FALLBACK]: names(MOVED),
    });
    expect(await fails(enigmoss.payments.get('p-1', { signal: controller.signal }))).toMatchObject({ code: 'aborted' });
    expect(to(ORIGIN)).toHaveLength(1);
    expect(to(FALLBACK)).toHaveLength(0);
  });

  it('when less than 3 s of the call are left', async () => {
    // One attempt of 2 s is the whole budget of the call.
    const { enigmoss, to } = setup(
      { [ORIGIN]: down, [FALLBACK]: names(MOVED), [MOVED]: () => ok() },
      { maxRetries: 0, timeout: 2_000 },
    );
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'network' });
    expect(to(FALLBACK)).toHaveLength(0);

    // Skipping is not a failed fallback: a call with enough time is not paused.
    await expect(enigmoss.payments.get('p-1', { timeout: 30_000 })).resolves.toEqual({ data: { id: 'x' } });
    expect(to(FALLBACK)).toHaveLength(1);
  });
});

describe('the time budget of the call', () => {
  it('a retry on the new origin does not start past the deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { enigmoss, to } = setup({
      [ORIGIN]: down,
      [FALLBACK]: names(MOVED),
      [MOVED]: () => {
        // The budget of this call is 3 attempts of 30 s and 2 waits of 10 s.
        vi.setSystemTime(Date.now() + 111_000);
        return apiError(503, 'dependency.unavailable');
      },
    });
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'dependency.unavailable' });
    expect(to(MOVED)).toHaveLength(1);
  });

  it('a retry on the new origin runs while there is time', async () => {
    const { enigmoss, to } = setup({
      [ORIGIN]: down,
      [FALLBACK]: names(MOVED),
      [MOVED]: () => apiError(503, 'dependency.unavailable'),
    });
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'dependency.unavailable' });
    expect(to(MOVED)).toHaveLength(3);
  });
});

describe('concurrent calls', () => {
  const slowly = (host: Host, ms = 20): Host => {
    return async (request) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return typeof host === 'function' ? host(request) : (host[0] as Reply);
    };
  };

  it('share one probe and all move', async () => {
    const { enigmoss, to, changes } = setup({
      [ORIGIN]: down,
      [FALLBACK]: slowly(names(MOVED)),
      [MOVED]: () => ok(),
    });
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => enigmoss.payments.get(`p-${n}`)));
    expect(results).toHaveLength(5);
    expect(to(FALLBACK)).toHaveLength(1);
    expect(to(ORIGIN)).toHaveLength(15);
    expect(
      to(MOVED)
        .map((request) => request.uri)
        .sort(),
    ).toEqual([1, 2, 3, 4, 5].map((n) => `/api/v4/payments/p-${n}`));
    expect(changes).toHaveLength(1);
  });

  it('share one probe and its error, each with its own cause', async () => {
    const { enigmoss, to } = setup({ [ORIGIN]: down, [FALLBACK]: slowly(() => apiError(429, 'rate_limit.exceeded')) });
    const errors = await Promise.all([1, 2, 3].map((n) => fails(enigmoss.payments.get(`p-${n}`))));
    expect(to(FALLBACK)).toHaveLength(1);
    for (const error of errors) {
      expect(error).toMatchObject({ code: 'rate_limit.exceeded', status: 429 });
    }
    expect(new Set(errors).size).toBe(3);
    expect(new Set(errors.map((error) => error.cause)).size).toBe(3);
  });

  it('a call that fails after the move follows it without a probe', async () => {
    let late = false;
    const { enigmoss, to } = setup({
      [ORIGIN]: async (request) => {
        if (request.uri.endsWith('/late') && !late) {
          late = true;
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return notSent();
      },
      [FALLBACK]: names(MOVED),
      [MOVED]: () => ok(),
    });
    await Promise.all([enigmoss.payments.get('early'), enigmoss.payments.get('late')]);
    expect(to(FALLBACK)).toHaveLength(1);
    expect(to(MOVED)).toHaveLength(2);
  });

  it('an abort ends the wait of one call, not the probe the others share', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { enigmoss, to } = setup({
      [ORIGIN]: down,
      [FALLBACK]: async (request) => {
        await gate;
        return brand(request, MOVED);
      },
      [MOVED]: () => ok(),
    });
    const controller = new AbortController();
    const aborted = fails(enigmoss.payments.get('p-1', { signal: controller.signal }));
    const waiting = enigmoss.payments.get('p-2');
    while (to(FALLBACK).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    controller.abort();
    expect(await aborted).toMatchObject({ code: 'aborted', outcomeUnknown: true });

    release?.();
    await expect(waiting).resolves.toEqual({ data: { id: 'x' } });
    expect(to(FALLBACK)).toHaveLength(1);
    expect(to(MOVED).map((request) => request.uri)).toEqual(['/api/v4/payments/p-2']);
  });
});

describe('the one-time nonce of the probe', () => {
  it('differs between probes, so does the signature within one second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const net = fakeHosts({ [ORIGIN]: down, [FALLBACK]: () => apiError(503, 'dependency.unavailable') });
    // Two clients: the second one is not held back by the pause of the first.
    for (const _ of [1, 2]) {
      await fails(client(net.fetch, { fallbackBaseUrl: FALLBACK }).payments.get('p-1'));
    }
    const [first, second] = net.to(FALLBACK) as [Sent, Sent];
    expect(net.to(FALLBACK)).toHaveLength(2);
    expect(second.headers['X-Timestamp']).toBe(first.headers['X-Timestamp']);
    expect(nonce(second)).not.toBe(nonce(first));
    expect(second.headers['X-Signature']).not.toBe(first.headers['X-Signature']);
  });

  it('ties an answer to its request: a recorded answer of the same second is rejected', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // The fallback host keeps the first genuine answer and replays it to every later probe.
    let recorded: { text: string; headers: Headers } | undefined;
    const net = fakeHosts({
      [ORIGIN]: down,
      [FALLBACK]: async (request) => {
        if (recorded === undefined) {
          const genuine = brand(request, MOVED);
          recorded = { text: await genuine.text(), headers: genuine.headers };
        }
        return new Response(recorded.text, { status: 200, headers: recorded.headers });
      },
      [MOVED]: () => ok(),
    });

    await expect(client(net.fetch, { fallbackBaseUrl: FALLBACK }).payments.get('p-1')).resolves.toEqual({
      data: { id: 'x' },
    });
    const replayed = await fails(client(net.fetch, { fallbackBaseUrl: FALLBACK }).payments.get('p-1'));

    const [first, second] = net.to(FALLBACK) as [Sent, Sent];
    // Same key, same second, same path: only the nonce tells the two requests apart.
    expect(second.headers['X-Timestamp']).toBe(first.headers['X-Timestamp']);
    expect(replayed).toMatchObject({ code: 'response.invalid', status: 200 });
    expect(replayed.message).toContain('X-Response-Signature does not match');
    expect(net.to(MOVED)).toHaveLength(1);
  });

  it('ties an answer to its request after a clock correction too', async () => {
    // The host shifts the client clock to the moment of a recorded answer, then replays it.
    const recordedAt = Math.floor(Date.now() / 1000) - 7_200;
    const net = fakeHosts({
      [ORIGIN]: down,
      [FALLBACK]: (request) => {
        if (Math.abs(Number(request.headers['X-Timestamp']) - recordedAt) > 5) {
          return json(401, {
            error: {
              code: 'auth.timestamp_expired',
              message: 'Timestamp expired.',
              details: { server_time: recordedAt },
            },
            meta: { request_id: 'req-1' },
          });
        }
        // Signed for the same timestamp and path, but for the request of another nonce.
        const other = { ...request, uri: `${PROBE_URI}?nonce=${'0'.repeat(32)}` };
        const signature = expectedSignature(PAYMENT_KEY, request.headers, 'GET', other.uri, '');
        return brand({ ...other, headers: { 'X-Signature': signature } }, MOVED, { timestamp: recordedAt });
      },
      [MOVED]: () => ok(),
    });
    const error = await fails(client(net.fetch, { fallbackBaseUrl: FALLBACK }).payments.get('p-1'));
    expect(error).toMatchObject({ code: 'response.invalid', status: 200 });
    expect(error.message).toContain('X-Response-Signature does not match');
    expect(net.to(FALLBACK)).toHaveLength(2);
    expect(net.to(MOVED)).toHaveLength(0);
  });
});

describe('a wrong local clock', () => {
  const expired = (serverTime: number) =>
    json(401, {
      error: {
        code: 'auth.timestamp_expired',
        type: 'authentication_error',
        message: 'Timestamp expired.',
        details: { server_time: serverTime },
      },
      meta: { request_id: 'req-1' },
    });

  it('is corrected once for the probe', async () => {
    const serverTime = Math.floor(Date.now() / 1000) + 3_600;
    const { enigmoss, to } = setup({
      [ORIGIN]: down,
      [FALLBACK]: (request) =>
        Math.abs(Number(request.headers['X-Timestamp']) - serverTime) > 5
          ? expired(serverTime)
          : brand(request, MOVED, { timestamp: serverTime }),
      [MOVED]: () => ok(),
    });
    await expect(enigmoss.payments.get('p-1')).resolves.toEqual({ data: { id: 'x' } });
    const [first, second] = to(FALLBACK) as [Sent, Sent];
    expect(to(FALLBACK)).toHaveLength(2);
    expect(Number(second.headers['X-Timestamp']) - Number(first.headers['X-Timestamp'])).toBeGreaterThanOrEqual(3_599);
    // The repeat is another request: a new nonce, hence a new signature.
    expect(nonce(second)).not.toBe(nonce(first));
    expect(second.headers['X-Signature']).not.toBe(first.headers['X-Signature']);
    expect(second.headers['X-Signature']).toBe(expectedSignature(PAYMENT_KEY, second.headers, 'GET', second.uri, ''));
  });

  it('is not corrected twice', async () => {
    const serverTime = Math.floor(Date.now() / 1000) + 3_600;
    const { enigmoss, to } = setup({ [ORIGIN]: down, [FALLBACK]: () => expired(serverTime), [MOVED]: () => ok() });
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'auth.timestamp_expired', status: 401 });
    expect(to(FALLBACK)).toHaveLength(2);
  });

  it('is not corrected for a drift below 30 s', async () => {
    const serverTime = Math.floor(Date.now() / 1000) + 10;
    const { enigmoss, to } = setup({ [ORIGIN]: down, [FALLBACK]: () => expired(serverTime) });
    expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'auth.timestamp_expired' });
    expect(to(FALLBACK)).toHaveLength(1);
  });
});

describe('a call for the platform brand itself', () => {
  it('resolves with the answer of the fallback host and moves', async () => {
    const { enigmoss, to, changes } = setup({ [ORIGIN]: down, [FALLBACK]: names(MOVED), [MOVED]: () => ok() });
    const result = await enigmoss.request<{ data: { api: { origin: string } } }>('GET', '/project/platform-brand');
    expect(result.data.api.origin).toBe(MOVED);
    expect(to(FALLBACK)).toHaveLength(1);
    expect(to(MOVED)).toHaveLength(0);
    expect(changes).toHaveLength(1);

    await enigmoss.payments.get('p-1');
    expect(to(MOVED)).toHaveLength(1);
  });

  it('resolves with it when the origin is the same', async () => {
    const { enigmoss, to, changes } = setup({ [ORIGIN]: down, [FALLBACK]: names(ORIGIN) });
    const result = await enigmoss.request<{ data: { api: { origin: string } } }>('GET', '/project/platform-brand');
    expect(result.data.api.origin).toBe(ORIGIN);
    expect(to(FALLBACK)).toHaveLength(1);
    expect(changes).toHaveLength(0);
  });
});

describe('fallback options', () => {
  const base: EnigmossOptions = { baseUrl: ORIGIN, projectId: PROJECT, paymentKey: 'k' };

  it.each([
    ['a relative URL', 'api.example.org'],
    ['http on a public host', 'http://api.example.org'],
    ['a path other than /api/v4', 'https://api.example.org/v3'],
    ['a query string', 'https://api.example.org?x=1'],
  ])('rejects %s as fallbackBaseUrl', (_, fallbackBaseUrl) => {
    expect(() => new Enigmoss({ ...base, fallbackBaseUrl })).toThrow(/^fallbackBaseUrl must /);
  });

  it('rejects an onOriginChange that is not a function', () => {
    expect(() => new Enigmoss({ ...base, onOriginChange: 'log' as unknown as () => void })).toThrow(EnigmossError);
  });

  it('normalizes fallbackBaseUrl like baseUrl', async () => {
    const { enigmoss, to } = setup(
      { [ORIGIN]: down, [FALLBACK]: names(MOVED), [MOVED]: () => ok() },
      { fallbackBaseUrl: 'https://API.example.org/api/v4/' },
    );
    await enigmoss.payments.get('p-1');
    expect(to(FALLBACK)[0]?.url).toBe(`${FALLBACK}${PROBE_URI}?nonce=${nonce(to(FALLBACK)[0] as Sent)}`);
  });

  it('rejects trailing junk after a loopback http origin', async () => {
    const primary = 'http://localhost:8080';
    const fallback = 'http://127.0.0.1:8081';
    for (const origin of ['http://localhost:8082\n', 'http://localhost:8082/', 'http://localhost:8082 ']) {
      const { enigmoss } = setup(
        { [primary]: down, [fallback]: names(origin) },
        { baseUrl: primary, fallbackBaseUrl: fallback },
      );
      expect(await fails(enigmoss.payments.get('p-1'))).toMatchObject({ code: 'response.invalid' });
    }
  });

  it('accepts a loopback http origin only from a loopback http fallback host', async () => {
    const primary = 'http://localhost:8080';
    const fallback = 'http://127.0.0.1:8081';
    const local = 'http://localhost:8082';
    const { enigmoss, to } = setup(
      { [primary]: down, [fallback]: names(local), [local]: () => ok() },
      { baseUrl: primary, fallbackBaseUrl: fallback },
    );
    await expect(enigmoss.payments.get('p-1')).resolves.toEqual({ data: { id: 'x' } });
    expect(to(local)).toHaveLength(1);
  });
});

describe('over real sockets', () => {
  async function listen(handler: RequestListener) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const close = () => new Promise((resolve) => server.close(resolve));
    return { origin: `http://127.0.0.1:${port}`, close };
  }

  it('a refused connection moves the client to the origin the fallback host names', async () => {
    const seen: string[] = [];
    const api = await listen((request, response) => {
      seen.push(`api ${request.method} ${request.url}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: { id: 'x' } }));
    });
    const fallback = await listen((request, response) => {
      seen.push(`fallback ${request.method} ${request.url}`);
      const body = JSON.stringify({ data: { brand: null, api: { origin: api.origin }, refresh_after: 3_600 } });
      const timestamp = String(Math.floor(Date.now() / 1000));
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Response-Timestamp': timestamp,
        'X-Response-Signature': createHmac('sha256', PAYMENT_KEY)
          .update(`${timestamp}\n${String(request.headers['x-signature'])}\n${body}`)
          .digest('hex'),
      });
      response.end(body);
    });
    // A port nothing listens on: the connection is refused before anything is sent.
    const dead = await listen(() => {});
    await dead.close();

    const changes: OriginChange[] = [];
    const enigmoss = new Enigmoss({
      baseUrl: dead.origin,
      fallbackBaseUrl: fallback.origin,
      projectId: PROJECT,
      paymentKey: PAYMENT_KEY,
      onOriginChange: (change) => changes.push(change),
    });
    try {
      await expect(enigmoss.payments.get('p-1')).resolves.toEqual({ data: { id: 'x' } });
      await expect(enigmoss.payments.get('p-2')).resolves.toEqual({ data: { id: 'x' } });
      expect(seen).toEqual([
        expect.stringMatching(/^fallback GET \/api\/v4\/project\/platform-brand\?nonce=[0-9a-f]{32}$/),
        'api GET /api/v4/payments/p-1',
        'api GET /api/v4/payments/p-2',
      ]);
      expect(changes).toMatchObject([{ previous: dead.origin, current: api.origin }]);
    } finally {
      await Promise.all([api.close(), fallback.close()]);
    }
  });
});
