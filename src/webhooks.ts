import { EnigmossError } from './error.js';
import { concat, hmacKey, unhex, utf8 } from './internal/crypto.js';
import type { RequestOptions, Transport } from './internal/transport.js';
import { ENDPOINTS } from './resources.js';
import type { ApiResponse, EventRecord, SendTestWebhookParams, WebhookEvent } from './types.js';

/** Accepted age of `X-Timestamp`, seconds. */
const TOLERANCE = 300;

/** Request headers in any common shape: a fetch `Headers`, or a plain object with any key case (Node, Express). */
export type WebhookHeaders =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/** Raw request body exactly as received. */
export type WebhookBody = string | Uint8Array | ArrayBuffer;

/** Incoming webhooks and the test webhook. */
export class Webhooks {
  private key: Promise<CryptoKey> | undefined;

  constructor(
    private readonly transport: Transport,
    private readonly projectId: string,
    private readonly paymentKey: string | undefined,
  ) {}

  /**
   * Verifies an incoming webhook and returns its parsed body. Checks that `X-Project-Uuid` is this
   * project, `X-Timestamp` is within 300 s and `X-Signature` is the HMAC of the raw body bytes with
   * the payment key. Throws `EnigmossError` with `code: 'webhook.invalid'`; answer such requests with HTTP 400.
   *
   * Pass the raw body: with Express use `express.raw({ type: 'application/json' })`, never a re-encoded object.
   */
  async verify<T = WebhookEvent>(rawBody: WebhookBody, headers: WebhookHeaders): Promise<T> {
    if (this.paymentKey === undefined) {
      throw new EnigmossError('Webhook verification needs the payment key: pass paymentKey to the client.', {
        code: 'config',
      });
    }
    const project = header(headers, 'x-project-uuid');
    const timestamp = header(headers, 'x-timestamp');
    const signature = header(headers, 'x-signature');
    if (project === null || timestamp === null || signature === null) {
      const missing = [
        project === null ? 'X-Project-Uuid' : null,
        timestamp === null ? 'X-Timestamp' : null,
        signature === null ? 'X-Signature' : null,
      ].filter((name) => name !== null);
      throw invalid(`The webhook has no ${missing.join(', ')} header; make sure the proxy passes it through.`);
    }
    if (project.toLowerCase() !== this.projectId.toLowerCase()) {
      throw invalid('The webhook is addressed to another project.');
    }
    if (!/^\d{1,10}$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > TOLERANCE) {
      throw invalid('The webhook timestamp is outside the accepted window of 300 seconds.');
    }

    const body =
      typeof rawBody === 'string'
        ? utf8(rawBody)
        : rawBody instanceof ArrayBuffer
          ? new Uint8Array(rawBody)
          : new Uint8Array(rawBody);
    const expected = unhex(signature.toLowerCase());
    this.key ??= hmacKey(this.paymentKey);
    // The signature covers the project value exactly as sent. subtle.verify compares in constant time.
    const valid =
      expected !== null &&
      expected.length === 32 &&
      (await crypto.subtle.verify('HMAC', await this.key, expected, concat(utf8(`${timestamp}\n${project}\n`), body)));
    if (!valid) {
      throw invalid(
        'The webhook signature does not match: verify the raw request body with the payment key of this project.',
      );
    }

    try {
      const event: unknown = JSON.parse(new TextDecoder().decode(body));
      if (typeof event === 'object' && event !== null && !Array.isArray(event)) {
        return event as T;
      }
    } catch {
      // Reported below.
    }
    throw invalid('The webhook body is not a JSON object.');
  }

  /** Sends a `webhook.test` event to the callback URL of the project. Payment key. `POST /api/v4/webhooks/test`. */
  sendTest(params?: SendTestWebhookParams, options?: RequestOptions): Promise<ApiResponse<EventRecord>> {
    return this.transport.execute(ENDPOINTS['webhooks.sendTest'], { body: params }, options);
  }
}

function header(headers: WebhookHeaders, name: string): string | null {
  let value: string | readonly string[] | null | undefined;
  if (typeof headers.get === 'function') {
    value = (headers as { get(name: string): string | null }).get(name);
  } else {
    const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
    value = key === undefined ? undefined : record[key];
  }
  const first = typeof value === 'string' ? value : value?.[0];
  const trimmed = first?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function invalid(message: string): EnigmossError {
  return new EnigmossError(message, { code: 'webhook.invalid' });
}
