# Changelog

All notable changes of the `enigmoss` package. The project follows semantic versioning.

## 0.1.0 — unreleased

- First release: client of the Project API v4 with all 34 operations, `request()` for any other
  endpoint, `webhooks.verify()`, request signing, Idempotency-Key derived from `order_id`, safe
  retries (`maxRetries`, `idempotency` options) and one `EnigmossError`.
