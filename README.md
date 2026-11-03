# enigmoss

Official TypeScript client of the Enigmoss Project API v4. A thin typed wrapper: one method per API
operation, parameters and responses exactly as on the wire, request signing, safe retries and
idempotency built in. Zero dependencies; runs on Node.js 22.12+, Bun, Deno, Cloudflare Workers and
Vercel Edge.

## Install

```sh
npm install enigmoss
```

## Usage

```ts
import { Enigmoss, EnigmossError } from 'enigmoss';

const enigmoss = new Enigmoss({
  baseUrl: process.env.ENIGMOSS_BASE_URL!, // API host from the dashboard
  projectId: process.env.ENIGMOSS_PROJECT_ID!,
  paymentKey: process.env.ENIGMOSS_PAYMENT_KEY,
  payoutKey: process.env.ENIGMOSS_PAYOUT_KEY,
});

const payment = await enigmoss.payments.create({ amount: '10.50', currency_code: 'USDT', order_id: 'order-42' });
const page = await enigmoss.payments.list({ status: 'paid', limit: 50, cursor }); // { data, meta } as returned by the API
const payout = await enigmoss.payouts.create({ order_id: 'w-7', amount: '25', currency_code: 'USDT', address });

// webhook: raw body + headers → verified JSON, or an EnigmossError
const event = await enigmoss.webhooks.verify(rawBody, headers);

// any endpoint the wrapper does not cover
const res = await enigmoss.request('GET', '/balances');
```

Every method resolves with the response body as the API returns it: `{ data, meta }`, snake_case
fields, money as decimal strings, dates as ISO strings. A list returns one page; fetch the next one
with the same call and `cursor: page.meta.cursor.next`.

## Which key for which endpoint

| Endpoints                                                                                                | Key                                     |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `payments`, `wallets`, `balances`, `transactions`, `paymentMethods.updateDiscount`, `events`, `webhooks` | `paymentKey`                            |
| `payouts`, `refunds`, `transfers`                                                                        | `payoutKey`                             |
| `project`, `paymentMethods.list`, `payoutMethods`, `exchangeRates`                                       | either (`paymentKey` when both are set) |

Pass only the keys you need. `webhooks.verify()` needs `paymentKey`.

## Three rules for money

1. **Money is a string.** `amount: '10.50'`, never a floating-point number.
2. **One `order_id`, one object.** Creates are idempotent by `order_id`: repeating `payouts.create`
   with the same `order_id` returns the stored payout and never pays twice.
3. **On `outcomeUnknown`, never create a new `order_id`.** The request may have been executed. Mark
   the operation as pending, then find it with `list({ order_id })` or repeat it with the same
   `order_id`.

```ts
try {
  await enigmoss.payouts.create({ order_id: 'w-7', amount: '25', currency_code: 'USDT', address });
} catch (error) {
  if (error instanceof EnigmossError && error.outcomeUnknown) {
    // pending: reconcile later with enigmoss.payouts.list({ order_id: 'w-7' })
  } else {
    throw error;
  }
}
```

## Errors

Every failure is an `EnigmossError`:

| Field            | Meaning                                                                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`           | Server code (`'payout.insufficient_funds'`, `'validation.failed'`, …), `'http.<status>'` for a response without the API error body, or `'network'`, `'timeout'`, `'aborted'`, `'response.invalid'`, `'webhook.invalid'`, `'config'` |
| `status`         | HTTP status, `null` when no response arrived                                                                                                                                                                                        |
| `outcomeUnknown` | `true` when the request may have been executed: the connection broke after sending, the call timed out or was aborted, the server answered 5xx or `idempotency.in_progress`, or a 2xx body could not be read                        |
| `requestId`      | Request id to quote to support                                                                                                                                                                                                      |
| `body`           | Response body as received; violations and details are here                                                                                                                                                                          |
| `cause`          | The underlying error, if any                                                                                                                                                                                                        |

Branch on `code`, never on the message.

## Webhooks

Verify the **raw** body bytes, never a re-parsed object. `verify()` checks `X-Project-Uuid`,
the `X-Timestamp` window (300 s) and the `X-Signature` HMAC, and returns the parsed
`{ event, event_id, created_at, data }`. On failure it throws `EnigmossError` with
`code: 'webhook.invalid'`: answer HTTP 400.

Express: `app.post('/webhooks', express.raw({ type: 'application/json' }), handler)`, then
`await enigmoss.webhooks.verify(req.body, req.headers)`.

Fetch-style runtimes (Bun, Deno, Workers, Next.js route handlers):

```ts
const event = await enigmoss.webhooks.verify(await request.text(), request.headers);
```

`event_id` stays the same across retries and redeliveries: deduplicate on it.

## Options

| Option                    | Default        | Meaning                                                                    |
| ------------------------- | -------------- | -------------------------------------------------------------------------- |
| `baseUrl`                 | required       | API host from the dashboard; the SDK appends `/api/v4`                     |
| `projectId`               | required       | Project UUID                                                               |
| `paymentKey`, `payoutKey` | —              | Pass the keys you need                                                     |
| `timeout`                 | `30_000` ms    | Per attempt; `payouts.create` and `refunds.create*` use at least `180_000` |
| `maxRetries`              | `2`            | `0` disables retries                                                       |
| `idempotency`             | `true`         | `false`: no Idempotency-Key from `order_id` (see below)                    |
| `fetch`                   | global `fetch` | Custom fetch: proxy, tests                                                 |

The last optional argument of every method is `{ timeout?, maxRetries?, idempotencyKey?, signal? }`.

**Retries** (exponential backoff 0.5–8 s with jitter, `Retry-After` up to 10 s honored): reads and
`payouts.quote` on network errors, 429 and 502–504. Money POSTs only when the request was not sent,
when it carried an Idempotency-Key, or on `rate_limit.exceeded`, `lock.not_acquired`,
`idempotency.in_progress`, `dependency.unavailable`. Business errors are never retried. Event
redelivery and the test webhook only when the request was not sent.

**Idempotency**: creates send `Idempotency-Key: sdk1-…` derived from the path and `order_id` (the
same key as the other official SDKs); other POST actions send a random key per call. With
`idempotency: false` a random key is sent only where the server requires one, and money POSTs are
not retried once sent. `{ idempotencyKey }` sets the key of one call.

## License

MIT
