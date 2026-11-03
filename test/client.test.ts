import { describe, expect, it } from 'vitest';
import { Enigmoss, EnigmossError, type EnigmossOptions } from '../src/index.js';
import { apiError, client, fakeFetch, json, ORIGIN, PROJECT } from './helpers.js';

const base: EnigmossOptions = { baseUrl: ORIGIN, projectId: PROJECT, paymentKey: 'k' };

describe('configuration', () => {
  it.each([
    ['no projectId', { projectId: '' }],
    ['no key', { paymentKey: undefined }],
    ['relative baseUrl', { baseUrl: 'api.example.com' }],
    ['http on a public host', { baseUrl: 'http://api.example.com' }],
    ['a path other than /api/v4', { baseUrl: 'https://api.example.com/v3' }],
    ['a query string', { baseUrl: 'https://api.example.com?x=1' }],
  ])('rejects %s', (_, override) => {
    expect(() => new Enigmoss({ ...base, ...override })).toThrow(EnigmossError);
    try {
      new Enigmoss({ ...base, ...override });
    } catch (error) {
      expect(error).toMatchObject({ code: 'config' });
    }
  });

  it.each([
    ['https://API.example.com/', 'https://api.example.com/api/v4/project'],
    ['https://api.example.com/api/v4/', 'https://api.example.com/api/v4/project'],
    ['https://api.example.com:8443', 'https://api.example.com:8443/api/v4/project'],
    ['http://localhost:8080', 'http://localhost:8080/api/v4/project'],
  ])('normalizes %s', async (baseUrl, url) => {
    const { fetch, sent } = fakeFetch();
    await new Enigmoss({ ...base, baseUrl, fetch }).project.get();
    expect(sent[0]?.url).toBe(url);
  });
});

describe('responses and errors', () => {
  it('resolves with the body exactly as the API returns it', async () => {
    const body = {
      data: [{ id: 'p1', amount: '10.50' }],
      meta: { cursor: { next: 'c2', prev: null, per_page: 1, has_more: true } },
    };
    const { fetch } = fakeFetch([json(200, body)]);
    await expect(client(fetch).payments.list()).resolves.toEqual(body);
  });

  it('carries code, status, requestId and the body of an API error', async () => {
    const response = apiError(422, 'payout.insufficient_funds');
    const { fetch } = fakeFetch([response]);
    const error = (await client(fetch)
      .payouts.create({ order_id: 'w', amount: '1', currency_code: 'USDT', address: 'a' })
      .catch((e: unknown) => e)) as EnigmossError;
    expect(error).toBeInstanceOf(EnigmossError);
    expect(error).toMatchObject({
      name: 'EnigmossError',
      code: 'payout.insufficient_funds',
      status: 422,
      outcomeUnknown: false,
      requestId: 'req-1',
      body: { error: { code: 'payout.insufficient_funds' } },
    });
    expect(error.message).toContain('[payout.insufficient_funds, request req-1]');
  });

  it('maps a response without the API error body to http.<status>', async () => {
    const { fetch } = fakeFetch([new Response('Not found', { status: 404, headers: { 'X-Request-Id': 'h-1' } })]);
    await expect(client(fetch).payments.get('p1')).rejects.toMatchObject({
      code: 'http.404',
      status: 404,
      requestId: 'h-1',
      body: 'Not found',
      outcomeUnknown: false,
    });
  });

  it('5xx and idempotency.in_progress have an unknown outcome', async () => {
    const { fetch } = fakeFetch([apiError(500, 'internal.server_error'), apiError(409, 'idempotency.in_progress')]);
    const enigmoss = client(fetch, { maxRetries: 0 });
    await expect(enigmoss.payments.get('p1')).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(
      enigmoss.transfers.create({ order_id: 't', amount: '1', currency_code: 'USDT' }),
    ).rejects.toMatchObject({ code: 'idempotency.in_progress', outcomeUnknown: true });
  });

  it('a connection that never opened has a known outcome', async () => {
    const { fetch } = fakeFetch([Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })]);
    await expect(client(fetch, { maxRetries: 0 }).payments.cancel('p1')).rejects.toMatchObject({
      code: 'network',
      outcomeUnknown: false,
      status: null,
    });
  });

  it('request() returns the parsed body and drops a body on GET', async () => {
    const { fetch, sent } = fakeFetch([json(200, { data: { ok: true } })]);
    const res = await client(fetch).request<{ data: { ok: boolean } }>('get', '/api/v4/balances', { body: { x: 1 } });
    expect(res.data.ok).toBe(true);
    expect(sent[0]).toMatchObject({ method: 'GET', uri: '/api/v4/balances', body: null });
  });

  it('request() POST is retried only when not sent, unless an idempotencyKey is passed', async () => {
    const lost = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const first = fakeFetch([lost(), json(200, { data: {} })]);
    await expect(client(first.fetch).request('POST', '/payments/p1/cancel')).rejects.toMatchObject({ code: 'network' });
    expect(first.sent).toHaveLength(1);

    const second = fakeFetch([lost(), json(200, { data: {} })]);
    await client(second.fetch).request('POST', '/payments/p1/cancel', {}, { idempotencyKey: 'k-1' });
    expect(second.sent).toHaveLength(2);
    expect(second.sent[1]?.headers['Idempotency-Key']).toBe('k-1');
  });
});
