import { type Endpoint, PAYOUT_TIMEOUT, type RequestOptions, type Transport } from './internal/transport.js';
import type {
  AmlVerificationLink,
  ApiList,
  ApiResponse,
  Balance,
  BlockWalletParams,
  BulkRedeliveryResult,
  CreatePaymentParams,
  CreatePaymentRefundParams,
  CreatePayoutParams,
  CreateTransferParams,
  CreateWalletParams,
  CreateWalletRefundParams,
  EventRecord,
  ExchangeRate,
  ExchangeRatesQuery,
  ListEventsQuery,
  ListPaymentsQuery,
  ListPayoutsQuery,
  ListRefundsQuery,
  ListTransactionsQuery,
  ListTransfersQuery,
  ListWalletsQuery,
  Payment,
  PaymentMethod,
  Payout,
  PayoutMethod,
  PayoutMethodDetails,
  PayoutQuote,
  Project,
  QuotePayoutParams,
  RedeliverBulkParams,
  Refund,
  Transaction,
  Transfer,
  UpdateDiscountParams,
  Wallet,
} from './types.js';

const get = (path: string, scope: Endpoint['scope']): Endpoint => ({ method: 'GET', path, scope, retry: 'read' });

/** A POST that creates an object identified by order_id; the default Idempotency-Key is derived from it. */
const create = (
  path: string,
  scope: Endpoint['scope'],
  idempotency: 'supported' | 'required',
  minTimeout?: number,
): Endpoint => ({
  method: 'POST',
  path,
  scope,
  retry: 'money',
  idempotency,
  orderKey: true,
  ...(minTimeout === undefined ? {} : { minTimeout }),
});

/** A POST action protected by a random per-call Idempotency-Key. */
const action = (path: string, scope: Endpoint['scope']): Endpoint => ({
  method: 'POST',
  path,
  scope,
  retry: 'money',
  idempotency: 'supported',
});

/** A POST without idempotency support: retried only when the request was not sent. */
const once = (path: string, scope: Endpoint['scope']): Endpoint => ({ method: 'POST', path, scope, retry: 'once' });

/** The 34 operations of the Project API v4. */
export const ENDPOINTS = {
  'payments.create': create('/payments', 'payment', 'supported'),
  'payments.get': get('/payments/{id}', 'payment'),
  'payments.list': get('/payments', 'payment'),
  'payments.cancel': action('/payments/{id}/cancel', 'payment'),
  'payments.markPaid': action('/payments/{id}/mark-paid', 'payment'),
  'payments.createAmlVerificationLinks': action('/payments/{id}/aml-verification-links', 'payment'),
  'wallets.create': create('/wallets', 'payment', 'supported'),
  'wallets.get': get('/wallets/{id}', 'payment'),
  'wallets.list': get('/wallets', 'payment'),
  'wallets.block': action('/wallets/{id}/block', 'payment'),
  // A quote is a calculation without side effects: retried like a read.
  'payouts.quote': { method: 'POST', path: '/payouts/quote', scope: 'payout', retry: 'read' },
  'payouts.create': create('/payouts', 'payout', 'required', PAYOUT_TIMEOUT),
  'payouts.get': get('/payouts/{id}', 'payout'),
  'payouts.list': get('/payouts', 'payout'),
  'refunds.createForPayment': create('/payments/{id}/refunds', 'payout', 'required', PAYOUT_TIMEOUT),
  'refunds.createForWallet': create('/wallets/{id}/refunds', 'payout', 'required', PAYOUT_TIMEOUT),
  'refunds.get': get('/refunds/{id}', 'payout'),
  'refunds.list': get('/refunds', 'payout'),
  'transfers.create': create('/transfers', 'payout', 'required'),
  'transfers.get': get('/transfers/{id}', 'payout'),
  'transfers.list': get('/transfers', 'payout'),
  'balances.list': get('/balances', 'payment'),
  'transactions.list': get('/transactions', 'payment'),
  'paymentMethods.list': get('/payment-methods', 'any'),
  // Setting a value is naturally idempotent: retried like a read.
  'paymentMethods.updateDiscount': {
    method: 'PATCH',
    path: '/payment-methods/{currency_code}/{network_code}',
    scope: 'payment',
    retry: 'read',
  },
  'payoutMethods.list': get('/payout-methods', 'any'),
  'payoutMethods.get': get('/payout-methods/{currency_code}/{network_code}', 'any'),
  'exchangeRates.list': get('/exchange-rates', 'any'),
  'project.get': get('/project', 'any'),
  'events.list': get('/events', 'payment'),
  'events.get': get('/events/{id}', 'payment'),
  'events.redeliver': once('/events/{id}/redeliver', 'payment'),
  'events.redeliverBulk': once('/events/redeliver', 'payment'),
  'webhooks.sendTest': once('/webhooks/test', 'payment'),
} as const satisfies Record<string, Endpoint>;

abstract class Resource {
  constructor(protected readonly transport: Transport) {}
}

/** Invoices: one-time payment pages. Payment key. */
export class Payments extends Resource {
  /**
   * Creates a payment. Repeating it with the same `order_id` returns the stored response, never a second payment.
   * `POST /api/v4/payments`.
   */
  create(params: CreatePaymentParams, options?: RequestOptions): Promise<ApiResponse<Payment>> {
    return this.transport.execute(ENDPOINTS['payments.create'], { body: params }, options);
  }

  /** Retrieves a payment by id. `GET /api/v4/payments/{id}`. */
  get(id: string, options?: RequestOptions): Promise<ApiResponse<Payment>> {
    return this.transport.execute(ENDPOINTS['payments.get'], { params: { id } }, options);
  }

  /** One page of payments, newest first; filter by `order_id` to find yours. `GET /api/v4/payments`. */
  list(query?: ListPaymentsQuery, options?: RequestOptions): Promise<ApiList<Payment>> {
    return this.transport.execute(ENDPOINTS['payments.list'], { query }, options);
  }

  /** Cancels a pending payment. `POST /api/v4/payments/{id}/cancel`. */
  cancel(id: string, options?: RequestOptions): Promise<ApiResponse<Payment>> {
    return this.transport.execute(ENDPOINTS['payments.cancel'], { params: { id } }, options);
  }

  /** Marks a payment as paid manually. `POST /api/v4/payments/{id}/mark-paid`. */
  markPaid(id: string, options?: RequestOptions): Promise<ApiResponse<Payment>> {
    return this.transport.execute(ENDPOINTS['payments.markPaid'], { params: { id } }, options);
  }

  /** Creates the AML verification links of a locked payment. `POST /api/v4/payments/{id}/aml-verification-links`. */
  createAmlVerificationLinks(
    id: string,
    options?: RequestOptions,
  ): Promise<ApiResponse<readonly AmlVerificationLink[]>> {
    return this.transport.execute(ENDPOINTS['payments.createAmlVerificationLinks'], { params: { id } }, options);
  }
}

/** Static wallets: permanent deposit addresses. Payment key. */
export class Wallets extends Resource {
  /** Creates a static wallet; idempotent by `order_id`. `POST /api/v4/wallets`. */
  create(params: CreateWalletParams, options?: RequestOptions): Promise<ApiResponse<Wallet>> {
    return this.transport.execute(ENDPOINTS['wallets.create'], { body: params }, options);
  }

  /** Retrieves a static wallet by id. `GET /api/v4/wallets/{id}`. */
  get(id: string, options?: RequestOptions): Promise<ApiResponse<Wallet>> {
    return this.transport.execute(ENDPOINTS['wallets.get'], { params: { id } }, options);
  }

  /** One page of static wallets. `GET /api/v4/wallets`. */
  list(query?: ListWalletsQuery, options?: RequestOptions): Promise<ApiList<Wallet>> {
    return this.transport.execute(ENDPOINTS['wallets.list'], { query }, options);
  }

  /** Blocks a static wallet. `POST /api/v4/wallets/{id}/block`. */
  block(id: string, params?: BlockWalletParams, options?: RequestOptions): Promise<ApiResponse<Wallet>> {
    return this.transport.execute(ENDPOINTS['wallets.block'], { params: { id }, body: params }, options);
  }
}

/** Payouts to external addresses. Payout key. */
export class Payouts extends Resource {
  /** Calculates fee and amounts of a payout without creating it. `POST /api/v4/payouts/quote`. */
  quote(params: QuotePayoutParams, options?: RequestOptions): Promise<ApiResponse<PayoutQuote>> {
    return this.transport.execute(ENDPOINTS['payouts.quote'], { body: params }, options);
  }

  /**
   * Creates a payout; idempotent by `order_id`, so a repeat never pays twice. Takes up to ~160 s:
   * the attempt timeout is at least 180 s. `POST /api/v4/payouts`.
   */
  create(params: CreatePayoutParams, options?: RequestOptions): Promise<ApiResponse<Payout>> {
    return this.transport.execute(ENDPOINTS['payouts.create'], { body: params }, options);
  }

  /** Retrieves a payout by id. `GET /api/v4/payouts/{id}`. */
  get(id: string, options?: RequestOptions): Promise<ApiResponse<Payout>> {
    return this.transport.execute(ENDPOINTS['payouts.get'], { params: { id } }, options);
  }

  /** One page of payouts; filter by `order_id` to reconcile. `GET /api/v4/payouts`. */
  list(query?: ListPayoutsQuery, options?: RequestOptions): Promise<ApiList<Payout>> {
    return this.transport.execute(ENDPOINTS['payouts.list'], { query }, options);
  }
}

/** Refunds of payments and static wallet deposits. Payout key. */
export class Refunds extends Resource {
  /** Refunds a payment; idempotent by `order_id`, attempt timeout at least 180 s. `POST /api/v4/payments/{id}/refunds`. */
  createForPayment(
    paymentId: string,
    params: CreatePaymentRefundParams,
    options?: RequestOptions,
  ): Promise<ApiResponse<Refund>> {
    return this.transport.execute(
      ENDPOINTS['refunds.createForPayment'],
      { params: { id: paymentId }, body: params },
      options,
    );
  }

  /** Refunds the balance of a blocked static wallet; idempotent by `order_id`. `POST /api/v4/wallets/{id}/refunds`. */
  createForWallet(
    walletId: string,
    params: CreateWalletRefundParams,
    options?: RequestOptions,
  ): Promise<ApiResponse<Refund>> {
    return this.transport.execute(
      ENDPOINTS['refunds.createForWallet'],
      { params: { id: walletId }, body: params },
      options,
    );
  }

  /** Retrieves a refund by id. `GET /api/v4/refunds/{id}`. */
  get(id: string, options?: RequestOptions): Promise<ApiResponse<Refund>> {
    return this.transport.execute(ENDPOINTS['refunds.get'], { params: { id } }, options);
  }

  /** One page of refunds. `GET /api/v4/refunds`. */
  list(query?: ListRefundsQuery, options?: RequestOptions): Promise<ApiList<Refund>> {
    return this.transport.execute(ENDPOINTS['refunds.list'], { query }, options);
  }
}

/** Transfers to the personal wallet of the project owner. Payout key. */
export class Transfers extends Resource {
  /** Creates a transfer; idempotent by `order_id`. `POST /api/v4/transfers`. */
  create(params: CreateTransferParams, options?: RequestOptions): Promise<ApiResponse<Transfer>> {
    return this.transport.execute(ENDPOINTS['transfers.create'], { body: params }, options);
  }

  /** Retrieves a transfer by id. `GET /api/v4/transfers/{id}`. */
  get(id: string, options?: RequestOptions): Promise<ApiResponse<Transfer>> {
    return this.transport.execute(ENDPOINTS['transfers.get'], { params: { id } }, options);
  }

  /** One page of transfers. `GET /api/v4/transfers`. */
  list(query?: ListTransfersQuery, options?: RequestOptions): Promise<ApiList<Transfer>> {
    return this.transport.execute(ENDPOINTS['transfers.list'], { query }, options);
  }
}

/** Balances of the project. Payment key. */
export class Balances extends Resource {
  /** Lists the balance of every currency. `GET /api/v4/balances`. */
  list(options?: RequestOptions): Promise<ApiResponse<readonly Balance[]>> {
    return this.transport.execute(ENDPOINTS['balances.list'], {}, options);
  }
}

/** Ledger of the project balance. Payment key. */
export class Transactions extends Resource {
  /** One page of balance transactions. `GET /api/v4/transactions`. */
  list(query?: ListTransactionsQuery, options?: RequestOptions): Promise<ApiList<Transaction>> {
    return this.transport.execute(ENDPOINTS['transactions.list'], { query }, options);
  }
}

/** Currencies and networks payers can pay with. */
export class PaymentMethods extends Resource {
  /** Lists the payment methods of the project. Either key. `GET /api/v4/payment-methods`. */
  list(options?: RequestOptions): Promise<ApiResponse<readonly PaymentMethod[]>> {
    return this.transport.execute(ENDPOINTS['paymentMethods.list'], {}, options);
  }

  /**
   * Sets the payer discount of one payment method. Payment key.
   * `PATCH /api/v4/payment-methods/{currency_code}/{network_code}`.
   */
  updateDiscount(
    currencyCode: string,
    networkCode: string,
    params: UpdateDiscountParams,
    options?: RequestOptions,
  ): Promise<ApiResponse<PaymentMethod>> {
    return this.transport.execute(
      ENDPOINTS['paymentMethods.updateDiscount'],
      { params: { currency_code: currencyCode, network_code: networkCode }, body: params },
      options,
    );
  }
}

/** Currencies and networks available for payouts. Either key. */
export class PayoutMethods extends Resource {
  /** Lists payout methods with limits and fees. `GET /api/v4/payout-methods`. */
  list(options?: RequestOptions): Promise<ApiResponse<readonly PayoutMethod[]>> {
    return this.transport.execute(ENDPOINTS['payoutMethods.list'], {}, options);
  }

  /** Details of one payout method. `GET /api/v4/payout-methods/{currency_code}/{network_code}`. */
  get(currencyCode: string, networkCode: string, options?: RequestOptions): Promise<ApiResponse<PayoutMethodDetails>> {
    return this.transport.execute(
      ENDPOINTS['payoutMethods.get'],
      { params: { currency_code: currencyCode, network_code: networkCode } },
      options,
    );
  }
}

/** Exchange rates. Either key. */
export class ExchangeRates extends Resource {
  /** Lists exchange rates, optionally of one base currency. `GET /api/v4/exchange-rates`. */
  list(query?: ExchangeRatesQuery, options?: RequestOptions): Promise<ApiResponse<readonly ExchangeRate[]>> {
    return this.transport.execute(ENDPOINTS['exchangeRates.list'], { query }, options);
  }
}

/** The project the key belongs to. Either key. */
export class ProjectResource extends Resource {
  /** The project, the key type, its permissions and the server time. `GET /api/v4/project`. */
  get(options?: RequestOptions): Promise<ApiResponse<Project>> {
    return this.transport.execute(ENDPOINTS['project.get'], {}, options);
  }
}

/** Webhook events and their delivery. Payment key. */
export class Events extends Resource {
  /** One page of webhook events. `GET /api/v4/events`. */
  list(query?: ListEventsQuery, options?: RequestOptions): Promise<ApiList<EventRecord>> {
    return this.transport.execute(ENDPOINTS['events.list'], { query }, options);
  }

  /** Retrieves an event with its delivery attempts. `GET /api/v4/events/{id}`. */
  get(id: string, options?: RequestOptions): Promise<ApiResponse<EventRecord>> {
    return this.transport.execute(ENDPOINTS['events.get'], { params: { id } }, options);
  }

  /** Sends an event to the callback URL again. `POST /api/v4/events/{id}/redeliver`. */
  redeliver(id: string, options?: RequestOptions): Promise<ApiResponse<EventRecord>> {
    return this.transport.execute(ENDPOINTS['events.redeliver'], { params: { id } }, options);
  }

  /** Queues the redelivery of the events matching a filter. `POST /api/v4/events/redeliver`. */
  redeliverBulk(params: RedeliverBulkParams, options?: RequestOptions): Promise<ApiResponse<BulkRedeliveryResult>> {
    return this.transport.execute(ENDPOINTS['events.redeliverBulk'], { body: params }, options);
  }
}
