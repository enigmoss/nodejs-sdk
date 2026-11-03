import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Enigmoss, EnigmossError } from '../src/index.js';
import { ENDPOINTS } from '../src/resources.js';
import { client, expectedSignature, fakeFetch, PAYMENT_KEY, PAYOUT_KEY } from './helpers.js';

const operations = Object.keys(
  JSON.parse(readFileSync(new URL('./fixtures/contract/openapi-v4.json', import.meta.url), 'utf8')).operations,
);

type Key = 'payment' | 'payout';

/** Every method of the client: the call, and the method, URI and key that must reach the wire. */
const methods: [string, (e: Enigmoss) => Promise<unknown>, string, string, Key][] = [
  [
    'payments.create',
    (e) => e.payments.create({ amount: '1', currency_code: 'USDT', order_id: 'o' }),
    'POST',
    '/payments',
    'payment',
  ],
  ['payments.get', (e) => e.payments.get('p1'), 'GET', '/payments/p1', 'payment'],
  ['payments.list', (e) => e.payments.list({ limit: 2 }), 'GET', '/payments?limit=2', 'payment'],
  ['payments.cancel', (e) => e.payments.cancel('p1'), 'POST', '/payments/p1/cancel', 'payment'],
  ['payments.markPaid', (e) => e.payments.markPaid('p1'), 'POST', '/payments/p1/mark-paid', 'payment'],
  [
    'payments.createAmlVerificationLinks',
    (e) => e.payments.createAmlVerificationLinks('p1'),
    'POST',
    '/payments/p1/aml-verification-links',
    'payment',
  ],
  [
    'wallets.create',
    (e) => e.wallets.create({ currency_code: 'USDT', network_code: 'TRX', order_id: 'w' }),
    'POST',
    '/wallets',
    'payment',
  ],
  ['wallets.get', (e) => e.wallets.get('w1'), 'GET', '/wallets/w1', 'payment'],
  ['wallets.list', (e) => e.wallets.list(), 'GET', '/wallets', 'payment'],
  ['wallets.block', (e) => e.wallets.block('w1', { refund_incoming: true }), 'POST', '/wallets/w1/block', 'payment'],
  [
    'payouts.quote',
    (e) => e.payouts.quote({ amount: '1', currency_code: 'USDT', address: 'a' }),
    'POST',
    '/payouts/quote',
    'payout',
  ],
  [
    'payouts.create',
    (e) => e.payouts.create({ order_id: 'o', amount: '1', currency_code: 'USDT', address: 'a' }),
    'POST',
    '/payouts',
    'payout',
  ],
  ['payouts.get', (e) => e.payouts.get('x1'), 'GET', '/payouts/x1', 'payout'],
  ['payouts.list', (e) => e.payouts.list({ order_id: 'o' }), 'GET', '/payouts?order_id=o', 'payout'],
  [
    'refunds.createForPayment',
    (e) => e.refunds.createForPayment('p1', { order_id: 'o', address: 'a' }),
    'POST',
    '/payments/p1/refunds',
    'payout',
  ],
  [
    'refunds.createForWallet',
    (e) => e.refunds.createForWallet('w1', { order_id: 'o', address: 'a' }),
    'POST',
    '/wallets/w1/refunds',
    'payout',
  ],
  ['refunds.get', (e) => e.refunds.get('r1'), 'GET', '/refunds/r1', 'payout'],
  ['refunds.list', (e) => e.refunds.list(), 'GET', '/refunds', 'payout'],
  [
    'transfers.create',
    (e) => e.transfers.create({ order_id: 'o', amount: '1', currency_code: 'USDT' }),
    'POST',
    '/transfers',
    'payout',
  ],
  ['transfers.get', (e) => e.transfers.get('t1'), 'GET', '/transfers/t1', 'payout'],
  ['transfers.list', (e) => e.transfers.list(), 'GET', '/transfers', 'payout'],
  ['balances.list', (e) => e.balances.list(), 'GET', '/balances', 'payment'],
  ['transactions.list', (e) => e.transactions.list({ type: 'payout' }), 'GET', '/transactions?type=payout', 'payment'],
  ['paymentMethods.list', (e) => e.paymentMethods.list(), 'GET', '/payment-methods', 'payment'],
  [
    'paymentMethods.updateDiscount',
    (e) => e.paymentMethods.updateDiscount('USDT', 'TRX', { discount_percent: 5 }),
    'PATCH',
    '/payment-methods/USDT/TRX',
    'payment',
  ],
  ['payoutMethods.list', (e) => e.payoutMethods.list(), 'GET', '/payout-methods', 'payment'],
  ['payoutMethods.get', (e) => e.payoutMethods.get('USDT', 'TRX'), 'GET', '/payout-methods/USDT/TRX', 'payment'],
  ['exchangeRates.list', (e) => e.exchangeRates.list({ from: 'USDT' }), 'GET', '/exchange-rates?from=USDT', 'payment'],
  ['project.get', (e) => e.project.get(), 'GET', '/project', 'payment'],
  ['events.list', (e) => e.events.list(), 'GET', '/events', 'payment'],
  ['events.get', (e) => e.events.get('e1'), 'GET', '/events/e1', 'payment'],
  ['events.redeliver', (e) => e.events.redeliver('e1'), 'POST', '/events/e1/redeliver', 'payment'],
  [
    'events.redeliverBulk',
    (e) => e.events.redeliverBulk({ created_from: '2026-01-01T00:00:00Z' }),
    'POST',
    '/events/redeliver',
    'payment',
  ],
  ['webhooks.sendTest', (e) => e.webhooks.sendTest(), 'POST', '/webhooks/test', 'payment'],
];

const normalize = (path: string) => path.replace(/\{[a-z_]+\}/g, '{id}');

describe('operations', () => {
  it('cover the 34 operations of the API contract exactly', () => {
    const ours = Object.values(ENDPOINTS).map((e) => `${e.method} ${normalize(e.path)}`);
    expect(ours).toHaveLength(34);
    expect([...ours].sort()).toEqual([...operations].sort());
  });

  it('every operation has a client method', () => {
    expect(methods.map(([name]) => name).sort()).toEqual(Object.keys(ENDPOINTS).sort());
  });

  it.each(methods)('%s', async (_, call, method, path, key) => {
    const { fetch, sent } = fakeFetch();
    await call(client(fetch));
    const request = sent[0];
    expect(request?.method).toBe(method);
    expect(request?.uri).toBe(`/api/v4${path}`);
    const secret = key === 'payout' ? PAYOUT_KEY : PAYMENT_KEY;
    expect(request?.headers['X-Signature']).toBe(
      expectedSignature(secret, request?.headers ?? {}, method, request?.uri ?? '', request?.body ?? ''),
    );
  });
});

describe('keys', () => {
  it('a payout endpoint without the payout key fails before sending', async () => {
    const { fetch, sent } = fakeFetch();
    const error = await client(fetch, { payoutKey: undefined })
      .payouts.list()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnigmossError);
    expect(error).toMatchObject({ code: 'config', outcomeUnknown: false });
    expect(sent).toHaveLength(0);
  });

  it('reference data is read with the payout key when it is the only one', async () => {
    const { fetch, sent } = fakeFetch();
    await client(fetch, { paymentKey: undefined }).project.get();
    const request = sent[0];
    expect(request?.headers['X-Signature']).toBe(
      expectedSignature(PAYOUT_KEY, request?.headers ?? {}, 'GET', '/api/v4/project', ''),
    );
  });
});
