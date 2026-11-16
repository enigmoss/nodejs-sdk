# Changelog

All notable changes of the `enigmoss` package. The project follows semantic versioning.

## 0.1.0 — unreleased

- First release: client of the Project API v4 with all 34 operations, `request()` for any other
  endpoint, `webhooks.verify()`, request signing, Idempotency-Key derived from `order_id`, safe
  retries (`maxRetries`, `idempotency` options) and one `EnigmossError`.
- `fallbackBaseUrl` option: when the API host cannot be reached (no connection was established) and
  the retries did not help, the client asks this second host for the current API origin with a
  signed `GET /project/platform-brand` (with a one-time nonce), verifies the response signature and
  repeats the call on the new origin with the same body and Idempotency-Key. The origin is kept in
  the client instance for `refresh_after` seconds (1 hour to 7 days). An error of the fallback host
  is thrown with the network error as `cause`; a fallback that did not move the client is not
  repeated for 5 minutes. Off unless the option is set.
- `onOriginChange` option and the `OriginChange` type: called when the client moves to another
  API origin.
