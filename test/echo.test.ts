import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Enigmoss } from '../src/index.js';
import { expectedSignature, PAYMENT_KEY, PAYOUT_KEY, PROJECT } from './helpers.js';

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

let server: Server;
let received: Received[] = [];
let enigmoss: Enigmoss;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { echo: body.toString('utf8') }, meta: { request_id: 'r-1' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  enigmoss = new Enigmoss({
    baseUrl: `http://127.0.0.1:${port}`,
    projectId: PROJECT,
    paymentKey: PAYMENT_KEY,
    payoutKey: PAYOUT_KEY,
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Checks the signature of what actually arrived, with an independent HMAC over the received bytes. */
function verifyOnServer(r: Received, key: string): void {
  const headers = {
    'X-Timestamp': String(r.headers['x-timestamp']),
    'X-Project-Uuid': String(r.headers['x-project-uuid']),
  };
  expect(r.headers['x-signature']).toBe(expectedSignature(key, headers, r.method, r.url, r.body.toString('utf8')));
  expect(r.headers['x-project-uuid']).toBe(PROJECT);
  expect(r.headers['user-agent']).toMatch(/^enigmoss-node-sdk\/\d+\.\d+\.\d+/);
}

describe('echo server: what is signed is what reaches the wire', () => {
  it('POST with a non-ASCII body: bytes unchanged, Content-Length matches', async () => {
    received = [];
    const params = { amount: '10.50', currency_code: 'USDT', order_id: 'Заказ №42', description: 'Оплата — café\r\n' };
    const response = await enigmoss.payments.create(params);
    const r = received[0] as Received;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('/api/v4/payments');
    expect(r.body.equals(Buffer.from(JSON.stringify(params), 'utf8'))).toBe(true);
    expect(Number(r.headers['content-length'])).toBe(r.body.length);
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['idempotency-key']).toMatch(/^sdk1-[0-9a-f]{59}$/);
    verifyOnServer(r, PAYMENT_KEY);
    expect(response).toEqual({ data: { echo: JSON.stringify(params) }, meta: { request_id: 'r-1' } });
  });

  it('GET with a query: the URI arrives exactly as signed, with no body', async () => {
    received = [];
    await enigmoss.payments.list({ order_id: "a b/ü!*'()", status: 'paid', limit: 50, cursor: null });
    const r = received[0] as Received;
    expect(r.url).toBe('/api/v4/payments?order_id=a%20b%2F%C3%BC%21%2A%27%28%29&status=paid&limit=50');
    expect(r.body.length).toBe(0);
    expect(r.headers['content-type']).toBeUndefined();
    verifyOnServer(r, PAYMENT_KEY);
  });

  it('path parameters are encoded once; payout endpoints are signed with the payout key', async () => {
    received = [];
    await enigmoss.refunds.createForPayment('p/1 ?', { order_id: 'r-1', address: 'T1' });
    const r = received[0] as Received;
    expect(r.url).toBe('/api/v4/payments/p%2F1%20%3F/refunds');
    verifyOnServer(r, PAYOUT_KEY);
  });

  it('an empty POST body is {}', async () => {
    received = [];
    await enigmoss.payments.cancel('p-1');
    const r = received[0] as Received;
    expect(r.body.toString('utf8')).toBe('{}');
    verifyOnServer(r, PAYMENT_KEY);
  });

  it('request() signs arbitrary endpoints the same way', async () => {
    received = [];
    await enigmoss.request('GET', '/balances', { query: { currency_code: 'USDT' } });
    await enigmoss.request('POST', '/transfers', { body: { order_id: 't-1', amount: '1', currency_code: 'USDT' } });
    const [get, post] = received as [Received, Received];
    expect(get.url).toBe('/api/v4/balances?currency_code=USDT');
    verifyOnServer(get, PAYMENT_KEY);
    expect(post.url).toBe('/api/v4/transfers');
    verifyOnServer(post, PAYOUT_KEY);
  });
});
