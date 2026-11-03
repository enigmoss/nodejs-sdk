import { EnigmossError } from './error.js';
import { API_PREFIX, type QueryValue, type RequestOptions, Transport } from './internal/transport.js';
import {
  Balances,
  Events,
  ExchangeRates,
  PaymentMethods,
  Payments,
  PayoutMethods,
  Payouts,
  ProjectResource,
  Refunds,
  Transactions,
  Transfers,
  Wallets,
} from './resources.js';
import { Webhooks } from './webhooks.js';

export interface EnigmossOptions {
  /** API host from the dashboard, e.g. `"https://api.example.com"`. The SDK appends `/api/v4` itself. */
  baseUrl: string;
  /** UUID of the project. */
  projectId: string;
  /** Payment key: payments, wallets, balances, transactions, events, webhooks. */
  paymentKey?: string | undefined;
  /** Payout key: payouts, refunds, transfers. */
  payoutKey?: string | undefined;
  /** Timeout of one attempt, ms. Default 30 000; payout and refund creation use at least 180 000. */
  timeout?: number;
  /** Retries of a failed attempt where a retry is safe. Default 2; `0` disables retries. */
  maxRetries?: number;
  /**
   * Derive the Idempotency-Key of create calls from `order_id`, so a repeated create returns the
   * stored response. Default `true`. With `false` a random key is sent only where the server
   * requires one, and money POSTs are never retried after they were sent.
   */
  idempotency?: boolean;
  /** Custom fetch (proxy, tests). Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** Parameters of `request()`. */
export interface RawRequest {
  /** Query parameters; null and undefined values are dropped. */
  query?: Readonly<Record<string, QueryValue>>;
  /** JSON body of a non-GET request; `{}` when omitted. */
  body?: object;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Client of the Project API v4. Every method sends one request and resolves with the response
 * body exactly as the API returns it (`{ data, meta }`); every failure is an `EnigmossError`.
 *
 * ```ts
 * const enigmoss = new Enigmoss({ baseUrl, projectId, paymentKey, payoutKey });
 * const { data: payment } = await enigmoss.payments.create({ amount: '10.50', currency_code: 'USDT', order_id: 'order-42' });
 * ```
 */
export class Enigmoss {
  readonly payments: Payments;
  readonly wallets: Wallets;
  readonly payouts: Payouts;
  readonly refunds: Refunds;
  readonly transfers: Transfers;
  readonly balances: Balances;
  readonly transactions: Transactions;
  readonly paymentMethods: PaymentMethods;
  readonly payoutMethods: PayoutMethods;
  readonly exchangeRates: ExchangeRates;
  readonly project: ProjectResource;
  readonly events: Events;
  readonly webhooks: Webhooks;

  private readonly transport: Transport;

  constructor(options: EnigmossOptions) {
    if (typeof options.projectId !== 'string' || options.projectId.trim() === '') {
      throw config('projectId is required.');
    }
    if (!options.paymentKey && !options.payoutKey) {
      throw config('Pass paymentKey, payoutKey or both.');
    }
    if (typeof (options.fetch ?? globalThis.fetch) !== 'function') {
      throw config('No global fetch in this runtime: pass the fetch option.');
    }

    const projectId = options.projectId.trim();
    const paymentKey = options.paymentKey || undefined;
    this.transport = new Transport({
      origin: origin(options.baseUrl),
      projectId,
      paymentKey,
      payoutKey: options.payoutKey || undefined,
      timeout: options.timeout ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      idempotency: options.idempotency ?? true,
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    });

    this.payments = new Payments(this.transport);
    this.wallets = new Wallets(this.transport);
    this.payouts = new Payouts(this.transport);
    this.refunds = new Refunds(this.transport);
    this.transfers = new Transfers(this.transport);
    this.balances = new Balances(this.transport);
    this.transactions = new Transactions(this.transport);
    this.paymentMethods = new PaymentMethods(this.transport);
    this.payoutMethods = new PayoutMethods(this.transport);
    this.exchangeRates = new ExchangeRates(this.transport);
    this.project = new ProjectResource(this.transport);
    this.events = new Events(this.transport);
    this.webhooks = new Webhooks(this.transport, projectId, paymentKey);
  }

  /**
   * Calls any endpoint, signed like the others. `path` is the part after `/api/v4`, e.g. `'/balances'`.
   * The payout key is used for payouts, refunds and transfers, the payment key for the rest. Non-GET
   * requests are retried only when they were not sent, or when `idempotencyKey` is passed.
   */
  request<T = unknown>(method: string, path: string, params: RawRequest = {}, options?: RequestOptions): Promise<T> {
    const upper = method.toUpperCase();
    const isGet = upper === 'GET';
    const relative = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) : path;
    const resolved = relative.startsWith('/') ? relative : `/${relative}`;
    return this.transport.execute<T>(
      {
        method: upper,
        path: resolved,
        scope: /^\/(payouts|refunds|transfers)\b|^\/(payments|wallets)\/[^/?]+\/refunds\b/.test(resolved)
          ? 'payout'
          : 'any',
        retry: isGet ? 'read' : options?.idempotencyKey !== undefined ? 'money' : 'once',
      },
      // No params: the path is used as given, without placeholder substitution.
      { query: params.query, body: isGet ? undefined : params.body },
      options,
    );
  }
}

/** Normalizes the base URL to an origin. https only, except loopback hosts for local development. */
function origin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(String(baseUrl).trim());
  } catch {
    throw config('baseUrl must be an absolute URL such as "https://api.example.com".');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw config('baseUrl must use https.');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw config('baseUrl must not contain credentials, a query string or a fragment.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== API_PREFIX) {
    throw config(
      `baseUrl must point at the API host ("https://api.example.com"), optionally followed by "${API_PREFIX}".`,
    );
  }
  return url.origin;
}

function config(message: string): EnigmossError {
  return new EnigmossError(message, { code: 'config' });
}
