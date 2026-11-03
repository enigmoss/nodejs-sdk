/**
 * The only error the SDK throws.
 *
 * `code` is the `error.code` of the API response (`'payout.insufficient_funds'`, …), `http.<status>`
 * for a response without the API error body (a proxy page), or one of the SDK codes:
 * `'network'`, `'timeout'`, `'aborted'`, `'response.invalid'`, `'webhook.invalid'`, `'config'`.
 *
 * When `outcomeUnknown` is `true` the request may have been executed: never create a new
 * `order_id` for the same operation; look the object up later or repeat with the same `order_id`.
 */
export class EnigmossError extends Error {
  /** Server error code or SDK code; branch on it, never on the message. */
  readonly code: string;
  /** HTTP status of the response, `null` when no response was received. */
  readonly status: number | null;
  /** The request may have been executed: reconcile before creating anything new. */
  readonly outcomeUnknown: boolean;
  /** `meta.request_id` or the `X-Request-Id` header; quote it to support. */
  readonly requestId: string | null;
  /** Response body as received: parsed JSON, or the raw text when it is not JSON. */
  readonly body: unknown;

  constructor(
    message: string,
    fields: {
      code: string;
      status?: number | null;
      outcomeUnknown?: boolean;
      requestId?: string | null;
      body?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.name = 'EnigmossError';
    this.code = fields.code;
    this.status = fields.status ?? null;
    this.outcomeUnknown = fields.outcomeUnknown ?? false;
    this.requestId = fields.requestId ?? null;
    this.body = fields.body;
  }
}
