// The first example of README.md, byte for byte (test/package.test.ts compares them).
// `npm run typecheck` compiles it against the sources.
// README example start
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
// README example end

declare const cursor: string | undefined;
declare const address: string;
declare const rawBody: string;
declare const headers: Record<string, string>;

export const results = [EnigmossError, payment.data.payment_url, page.meta.cursor.next, payout.data.status, event.event_id, res];
