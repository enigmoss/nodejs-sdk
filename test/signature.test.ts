import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hmacKey, orderIdempotencyKey, rawUrlEncode, signRequest, utf8 } from '../src/internal/crypto.js';
import { buildRequestUri } from '../src/internal/transport.js';

interface RequestVector {
  name: string;
  method: string;
  path: string;
  body: string;
  body_bytes: number;
  key_type: 'payment' | 'payout';
  string_to_sign: string;
  signature: string;
}

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/contract/signature-vectors.json', import.meta.url), 'utf8'),
);
const request = vectors.request as {
  timestamp: string;
  project: string;
  secrets: Record<string, string>;
  vectors: RequestVector[];
};

describe('request signature vectors', () => {
  it.each(request.vectors.map((v) => [v.name, v] as const))('%s', async (_, vector) => {
    const body = utf8(vector.body);
    expect(body.length).toBe(vector.body_bytes);
    const key = await hmacKey(request.secrets[vector.key_type] as string);
    const signature = await signRequest(
      key,
      Number(request.timestamp),
      request.project,
      vector.method,
      vector.path,
      body,
    );
    expect(signature).toBe(vector.signature);
  });
});

describe('idempotency key derived from order_id', () => {
  // Expected values computed by the reference algorithm of the PHP SDK:
  // php -r 'echo "sdk1-" . substr(hash("sha256", $uri . "\n" . $orderId), 0, 59);'
  it.each([
    ['/api/v4/payouts', 'w-7', 'sdk1-cb63fbc5a317a1bbe87ab542f5980a1a048b5b60f3c49a0de8654500566'],
    ['/api/v4/payments', 'order-42', 'sdk1-55fdd8c6b823fca6609d1a0128773fabdb7d34f8333428f4c21b0c5d1ff'],
    [
      '/api/v4/payments/0b9c1f8e-3a5d-4c7b-8e2f-1a2b3c4d5e6f/refunds',
      'refund-1',
      'sdk1-aefec106432f695ceac2a47a6c2caa368b72cf62201f9268a40185cb8c0',
    ],
    ['/api/v4/transfers', 'Заказ №42 — café', 'sdk1-5ff9d4a381ccd2060c71b462c30f848cf211b15b95a3add8239bb50c8d2'],
  ])('%s %s', async (uri, orderId, expected) => {
    const key = await orderIdempotencyKey(uri, orderId);
    expect(key).toBe(expected);
    expect(key).toHaveLength(64);
  });
});

describe('request URI', () => {
  it('encodes like PHP rawurlencode', () => {
    expect(rawUrlEncode("a b+c/d?e&f=g!*'()~._-ü")).toBe('a%20b%2Bc%2Fd%3Fe%26f%3Dg%21%2A%27%28%29~._-%C3%BC');
  });

  it('keeps order, drops null and undefined, writes booleans as words', () => {
    expect(
      buildRequestUri('/api/v4/payments', { status: 'paid', cursor: null, limit: 50, order_id: undefined, x: true }),
    ).toBe('/api/v4/payments?status=paid&limit=50&x=true');
  });

  it('never emits a bare question mark', () => {
    expect(buildRequestUri('/api/v4/payments', {})).toBe('/api/v4/payments');
    expect(buildRequestUri('/api/v4/payments', { cursor: null })).toBe('/api/v4/payments');
  });
});
