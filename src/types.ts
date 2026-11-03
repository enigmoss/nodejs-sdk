/**
 * Request and response shapes of the Project API v4, field for field as on the wire (snake_case).
 * Money amounts are decimal strings, dates are ISO 8601 strings. Enumerations are open: the server
 * may add values, so every union also accepts any other string.
 */

/** An open union: the listed values plus any string the server may add later. */
type Open<T extends string> = T | (string & {});

/** Decimal number as a string, e.g. `"10.50"`. Never use floating point for money. */
export type Decimal = string;
/** ISO 8601 date-time string. */
export type DateTime = string;

/** Response of a single object: `{ data, meta }` exactly as the API returns it. */
export interface ApiResponse<T> {
  readonly data: T;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** One page of a list. Fetch the next one with the same call and `cursor: meta.cursor.next`. */
export interface ApiList<T> {
  readonly data: readonly T[];
  readonly meta: ListMeta;
}

export interface ListMeta {
  readonly cursor: {
    readonly next: string | null;
    readonly prev: string | null;
    readonly per_page: number;
    readonly has_more: boolean;
  };
  readonly [key: string]: unknown;
}

/** Shared parameters of cursor lists. */
export interface ListQuery {
  /** Page size. */
  readonly limit?: number | null;
  /** `meta.cursor.next` (or `prev`) of the previous page. */
  readonly cursor?: string | null;
  readonly created_from?: DateTime | null;
  readonly created_to?: DateTime | null;
}

// Payments

export type PaymentStatus = Open<
  | 'pending'
  | 'processing'
  | 'confirming'
  | 'paid'
  | 'overpaid'
  | 'underpaid'
  | 'underpaid_waiting'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'locked'
  | 'refunding'
  | 'refunded'
  | 'refund_failed'
>;

export interface PaymentMethodRef {
  readonly currency_code: string;
  readonly network_code?: string;
}

export interface CreatePaymentParams {
  readonly amount: Decimal;
  readonly currency_code: string;
  /** Your unique id of the payment; also the source of the default Idempotency-Key. */
  readonly order_id: string;
  readonly settlement_currency_code?: string;
  readonly network_code?: string;
  readonly return_url?: string;
  readonly success_url?: string;
  readonly callback_url?: string;
  /** Lifetime, minutes. */
  readonly expires_in?: number;
  readonly allow_multiple_payments?: boolean;
  readonly customer_fee_percent?: number;
  readonly underpayment_tolerance_percent?: Decimal;
  readonly discount_percent?: number;
  readonly allowed_methods?: readonly PaymentMethodRef[];
  readonly excluded_methods?: readonly PaymentMethodRef[];
  readonly customer_email?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly description?: string;
  readonly theme?: Open<'light' | 'dark' | 'system'>;
  readonly referral_code?: string;
}

export interface ListPaymentsQuery extends ListQuery {
  readonly order_id?: string | null;
  readonly wallet_id?: string | null;
  readonly status?: PaymentStatus | null;
}

export interface Payment {
  readonly id: string;
  readonly order_id: string | null;
  readonly wallet_id: string | null;
  readonly status: PaymentStatus;
  readonly is_final: boolean;
  readonly failure_code: Open<'payment_failed' | 'processing_error'> | null;
  readonly amount: Decimal | null;
  readonly currency_code: string;
  readonly payer: {
    readonly amount: Decimal | null;
    readonly currency_code: string | null;
    readonly network_code: string | null;
    readonly address: string | null;
    readonly sender_address: string | null;
    readonly exchange_rate: Decimal | null;
  };
  readonly paid: { readonly amount: Decimal | null; readonly amount_usd: Decimal | null };
  readonly settlement: {
    readonly amount: Decimal | null;
    readonly currency_code: string | null;
    readonly fee: Decimal | null;
  };
  readonly conversion: {
    readonly from: {
      readonly amount: Decimal | null;
      readonly currency_code: string | null;
      readonly network_code: string | null;
    };
    readonly to: { readonly amount: Decimal | null; readonly currency_code: string | null };
    readonly rate: Decimal | null;
  } | null;
  readonly discount: { readonly percent: number | null; readonly amount: Decimal | null };
  readonly tx_hash: string | null;
  readonly payment_url: string | null;
  readonly expires_at: DateTime | null;
  readonly created_at: DateTime | null;
  readonly updated_at: DateTime | null;
  readonly paid_at: DateTime | null;
  readonly description: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}

export interface AmlVerificationLink {
  readonly url: string | null;
  readonly status: Open<'init' | 'pending' | 'completed'> | null;
  readonly expires_at: DateTime | null;
}

// Static wallets

export type WalletStatus = Open<'active' | 'blocked' | 'inactive'>;

export interface CreateWalletParams {
  readonly currency_code: string;
  readonly network_code: string;
  /** Your unique id of the wallet; also the source of the default Idempotency-Key. */
  readonly order_id: string;
  readonly callback_url?: string;
  readonly referral_code?: string;
}

export interface BlockWalletParams {
  /** Refund payments that arrive after blocking. */
  readonly refund_incoming?: boolean;
}

export interface ListWalletsQuery extends ListQuery {
  readonly order_id?: string | null;
  readonly status?: WalletStatus | null;
  readonly currency_code?: string | null;
  readonly network_code?: string | null;
}

export interface Wallet {
  readonly id: string;
  readonly order_id: string | null;
  readonly currency_code: string;
  readonly network_code: string;
  readonly address: string;
  readonly status: WalletStatus;
  readonly refund_incoming: boolean;
  readonly callback_url: string | null;
  readonly payment_url: string;
  readonly created_at: DateTime | null;
  readonly updated_at: DateTime | null;
}

// Payouts

export type PayoutStatus = Open<'pending' | 'processing' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'>;
export type PayoutPriority = Open<'recommended' | 'economy' | 'high' | 'highest'>;
export type RateSource = Open<'Binance' | 'Exmo' | 'Garantexio' | 'Kucoin'>;

export interface QuotePayoutParams {
  readonly amount: Decimal;
  readonly currency_code: string;
  readonly address: string;
  readonly network_code?: string;
  readonly recipient_currency_code?: string;
  readonly source_currency_code?: string;
  readonly fee_deducted_from_amount?: boolean;
  readonly rate_source?: RateSource;
  readonly priority?: PayoutPriority;
}

export interface CreatePayoutParams extends QuotePayoutParams {
  /** Your unique id of the payout; also the source of the default Idempotency-Key. */
  readonly order_id: string;
  readonly memo?: string;
  readonly callback_url?: string;
}

export interface ListPayoutsQuery extends ListQuery {
  readonly order_id?: string | null;
  readonly status?: PayoutStatus | null;
}

export interface PayoutAmounts {
  readonly recipient: { readonly amount: Decimal | null; readonly currency_code: string | null };
  readonly charged: {
    readonly amount: Decimal | null;
    readonly currency_code: string | null;
    readonly fee: Decimal | null;
  };
  readonly conversion: {
    readonly source_currency_code: string | null;
    readonly source_amount: Decimal | null;
    readonly fee: Decimal | null;
    readonly rate: Decimal | null;
  } | null;
}

export interface PayoutQuote extends PayoutAmounts {
  readonly amount: Decimal | null;
  readonly currency_code: string;
  readonly network_code: string;
  readonly priority: PayoutPriority;
}

export interface Payout extends PayoutAmounts {
  readonly id: string;
  readonly order_id: string;
  readonly status: PayoutStatus;
  readonly is_final: boolean;
  readonly failure_code: string | null;
  readonly amount: Decimal | null;
  readonly currency_code: string | null;
  readonly network_code: string | null;
  readonly address: string;
  readonly memo: string | null;
  readonly priority: PayoutPriority | null;
  readonly tx_hash: string | null;
  readonly created_at: DateTime | null;
  readonly updated_at: DateTime | null;
}

// Refunds

export type RefundStatus = Open<'pending' | 'processing' | 'completed' | 'failed'>;
export type RefundSource = Open<'payment' | 'aml' | 'blocked_wallet'>;

export interface CreatePaymentRefundParams {
  /** Your unique id of the refund; also the source of the default Idempotency-Key. */
  readonly order_id: string;
  readonly address: string;
  /** Omit to refund the whole paid amount. */
  readonly amount?: Decimal;
  readonly fee_deducted_from_amount?: boolean;
  readonly callback_url?: string;
}

export interface CreateWalletRefundParams {
  /** Your unique id of the refund; also the source of the default Idempotency-Key. */
  readonly order_id: string;
  readonly address: string;
  readonly callback_url?: string;
}

export interface ListRefundsQuery extends ListQuery {
  readonly order_id?: string | null;
  readonly source?: RefundSource | null;
  readonly status?: RefundStatus | null;
  readonly payment_id?: string | null;
  readonly wallet_id?: string | null;
}

export interface Refund {
  readonly id: string;
  readonly order_id: string | null;
  readonly source: RefundSource;
  readonly payment_id: string | null;
  readonly wallet_id: string | null;
  readonly status: RefundStatus;
  readonly is_final: boolean;
  readonly failure_code: Open<'payout_failed' | 'system_error' | 'aml_refund_failed' | 'gateway_rejected'> | null;
  readonly amount: Decimal | null;
  readonly currency_code: string;
  readonly network_code: string;
  readonly address: string;
  readonly tx_hash: string | null;
  readonly created_at: DateTime | null;
  readonly updated_at: DateTime | null;
  readonly completed_at: DateTime | null;
}

// Transfers

export interface CreateTransferParams {
  /** Your unique id of the transfer; also the source of the default Idempotency-Key. */
  readonly order_id: string;
  readonly amount: Decimal;
  readonly currency_code: string;
}

export interface ListTransfersQuery {
  readonly order_id?: string | null;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

export interface Transfer {
  readonly id: string;
  readonly order_id: string | null;
  readonly amount: Decimal;
  readonly currency_code: string;
  readonly transaction_id: string | null;
  readonly created_at: DateTime | null;
}

// Balances, transactions, reference data

export interface Balance {
  readonly currency_code: string;
  readonly balance: Decimal;
  readonly balance_usd: Decimal | null;
}

export type TransactionType = Open<
  'payment' | 'payment_hold' | 'payout' | 'refund' | 'transfer' | 'conversion_out' | 'conversion_in' | 'other'
>;

export interface ListTransactionsQuery extends ListQuery {
  readonly type?: TransactionType | null;
}

export interface Transaction {
  readonly id: string;
  readonly type: TransactionType;
  readonly amount: Decimal;
  readonly fee: Decimal;
  readonly currency_code: string;
  readonly network_code: string | null;
  readonly payment_id: string | null;
  readonly payout_id: string | null;
  readonly refund_id: string | null;
  readonly transfer_id: string | null;
  readonly created_at: DateTime;
}

export interface PaymentMethod {
  readonly currency_code: string;
  readonly network_code: string;
  readonly is_enabled: boolean;
  readonly discount_percent: number | null;
}

export interface UpdateDiscountParams {
  readonly discount_percent: number;
}

export interface PayoutMethod {
  readonly currency_code: string;
  readonly network_code: string;
  readonly contract_address: string | null;
  readonly min_amount: Decimal;
  readonly max_amount: Decimal;
  readonly fee: { readonly amount: Decimal; readonly percent: Decimal };
}

export interface PayoutMethodDetails {
  readonly currency_code: string;
  readonly network_code: string;
  readonly network_name: string | null;
  readonly token_standard: string | null;
  readonly min_amount: Decimal;
  readonly max_amount: Decimal;
  readonly decimals: number;
  readonly is_memo_available: boolean;
  readonly priorities: readonly { readonly priority: PayoutPriority; readonly fee: Decimal }[];
}

export interface ExchangeRatesQuery {
  /** Base currency code; omit for all pairs. */
  readonly from?: string | null;
}

export interface ExchangeRate {
  readonly from: string;
  readonly to: string;
  readonly rate: Decimal;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly key_type: Open<'payment' | 'payout'>;
  readonly permissions: readonly string[];
  /** Unix time of the server, seconds. */
  readonly server_time: number;
}

// Webhook events

export type DeliveryStatus = Open<'pending' | 'delivered' | 'failed' | 'superseded' | 'no_destination'>;
export type WebhookObjectType = Open<'payment' | 'wallet' | 'payout' | 'refund'>;

/** Body of a webhook, as verified by `webhooks.verify()` and stored as `payload` of an event record. */
export interface WebhookEvent<T = Readonly<Record<string, unknown>> | null> {
  /** `"<object>.<status>"`, e.g. `"payment.paid"`, or `"webhook.test"`. */
  readonly event: string;
  /** Stable across retries and redeliveries: deduplicate on it. */
  readonly event_id: string;
  readonly created_at: DateTime;
  readonly data: T;
}

export interface DeliveryAttempt {
  readonly number: number;
  readonly trigger: Open<'auto' | 'retry' | 'proxy_retry' | 'manual' | 'bulk'>;
  readonly status: DeliveryStatus;
  readonly url: string | null;
  readonly response_status_code: number | null;
  readonly response_body: string | null;
  readonly scheduled_at: DateTime | null;
  readonly created_at: DateTime;
  readonly updated_at: DateTime | null;
}

export interface EventRecord {
  readonly id: string;
  readonly event: string;
  readonly object_type: WebhookObjectType | null;
  readonly object_id: string | null;
  readonly delivery_status: DeliveryStatus;
  readonly created_at: DateTime;
  readonly payload: WebhookEvent;
  /** Present on `events.get()` and redelivery responses. */
  readonly attempts?: readonly DeliveryAttempt[];
}

export interface ListEventsQuery extends ListQuery {
  readonly event?: string | null;
  readonly object_type?: WebhookObjectType | null;
  readonly object_id?: string | null;
  readonly delivery_status?: DeliveryStatus | null;
}

export interface RedeliverBulkParams {
  readonly created_from: DateTime;
  readonly created_to?: DateTime;
  readonly event?: string;
  readonly object_type?: WebhookObjectType;
  readonly object_id?: string;
  readonly delivery_status?: DeliveryStatus;
}

export interface BulkRedeliveryResult {
  readonly queued: number;
  readonly already_pending: number;
  readonly skipped_outdated: number;
}

export interface SendTestWebhookParams {
  /** Deliver to this URL instead of the project's callback URL. */
  readonly callback_url?: string;
}
