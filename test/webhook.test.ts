import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Enigmoss, EnigmossError } from '../src/index.js';
import { fakeFetch } from './helpers.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/contract/signature-vectors.json', import.meta.url), 'utf8'),
);
const vector = fixture.webhook.vectors[0] as {
  timestamp: string;
  project: string;
  secret: string;
  body: string;
  signature: string;
};

const enigmoss = new Enigmoss({
  baseUrl: 'https://api.example.com',
  projectId: vector.project,
  paymentKey: vector.secret,
  fetch: fakeFetch().fetch,
});

const headers = {
  'X-Project-Uuid': vector.project,
  'X-Timestamp': vector.timestamp,
  'X-Signature': vector.signature,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Number(vector.timestamp) * 1000);
});
afterEach(() => {
  vi.useRealTimers();
});

async function rejection(promise: Promise<unknown>): Promise<EnigmossError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EnigmossError);
  return error as EnigmossError;
}

describe('webhooks.verify', () => {
  it('accepts the contract vector and returns the parsed body as is', async () => {
    await expect(enigmoss.webhooks.verify(vector.body, headers)).resolves.toEqual(JSON.parse(vector.body));
  });

  it('accepts Uint8Array, ArrayBuffer, a Headers object and lower-case or array header values', async () => {
    const bytes = new TextEncoder().encode(vector.body);
    await expect(enigmoss.webhooks.verify(bytes, new Headers(headers))).resolves.toMatchObject({
      event: 'webhook.test',
    });
    await expect(enigmoss.webhooks.verify(bytes.buffer, headers)).resolves.toMatchObject({ event: 'webhook.test' });
    await expect(
      enigmoss.webhooks.verify(vector.body, {
        'x-project-uuid': vector.project.toUpperCase(),
        'x-timestamp': [vector.timestamp],
        'x-signature': vector.signature.toUpperCase(),
      }),
    ).rejects.toThrow(/signature/); // the signature covers the project value exactly as sent
    await expect(
      enigmoss.webhooks.verify(vector.body, {
        'x-project-uuid': vector.project,
        'x-timestamp': [vector.timestamp],
        'x-signature': vector.signature.toUpperCase(),
      }),
    ).resolves.toMatchObject({ event_id: '019b7710-0000-7000-8000-000000000001' });
  });

  it('rejects a tampered body', async () => {
    const error = await rejection(
      enigmoss.webhooks.verify(vector.body.replace('webhook.test', 'payment.paid'), headers),
    );
    expect(error.code).toBe('webhook.invalid');
    expect(error.outcomeUnknown).toBe(false);
  });

  it('rejects a body re-encoded from the parsed object', async () => {
    const error = await rejection(enigmoss.webhooks.verify(JSON.stringify(JSON.parse(vector.body)), headers));
    expect(error.code).toBe('webhook.invalid');
  });

  it('rejects a forged signature', async () => {
    const error = await rejection(
      enigmoss.webhooks.verify(vector.body, { ...headers, 'X-Signature': '00'.repeat(32) }),
    );
    expect(error.code).toBe('webhook.invalid');
    const garbage = await rejection(enigmoss.webhooks.verify(vector.body, { ...headers, 'X-Signature': 'zz' }));
    expect(garbage.code).toBe('webhook.invalid');
  });

  it('rejects an expired or future timestamp, even with a valid signature for it', async () => {
    for (const shift of [301, -301]) {
      const timestamp = String(Number(vector.timestamp) - shift);
      const signature = createHmac('sha256', vector.secret)
        .update(`${timestamp}\n${vector.project}\n${vector.body}`)
        .digest('hex');
      const error = await rejection(
        enigmoss.webhooks.verify(vector.body, { ...headers, 'X-Timestamp': timestamp, 'X-Signature': signature }),
      );
      expect(error.code).toBe('webhook.invalid');
      expect(error.message).toMatch(/timestamp/);
    }
  });

  it('accepts a timestamp at the edge of the 300 s window', async () => {
    vi.setSystemTime((Number(vector.timestamp) + 300) * 1000);
    await expect(enigmoss.webhooks.verify(vector.body, headers)).resolves.toBeTruthy();
  });

  it('rejects a webhook of another project', async () => {
    const error = await rejection(
      enigmoss.webhooks.verify(vector.body, { ...headers, 'X-Project-Uuid': '00000000-0000-4000-8000-000000000000' }),
    );
    expect(error.message).toMatch(/another project/);
  });

  it('names the missing headers', async () => {
    const error = await rejection(enigmoss.webhooks.verify(vector.body, { 'X-Project-Uuid': vector.project }));
    expect(error.code).toBe('webhook.invalid');
    expect(error.message).toContain('X-Timestamp, X-Signature');
  });

  it('rejects a validly signed body that is not a JSON object', async () => {
    const body = '[1,2]';
    const signature = createHmac('sha256', vector.secret)
      .update(`${vector.timestamp}\n${vector.project}\n${body}`)
      .digest('hex');
    const error = await rejection(enigmoss.webhooks.verify(body, { ...headers, 'X-Signature': signature }));
    expect(error.message).toMatch(/JSON object/);
  });

  it('needs the payment key', async () => {
    const payoutOnly = new Enigmoss({
      baseUrl: 'https://api.example.com',
      projectId: vector.project,
      payoutKey: 'x',
      fetch: fakeFetch().fetch,
    });
    const error = await rejection(payoutOnly.webhooks.verify(vector.body, headers));
    expect(error.code).toBe('config');
  });
});
