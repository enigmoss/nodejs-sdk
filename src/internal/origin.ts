/** Request URI of the probe sent to the fallback host. */
export const PROBE_URI = '/api/v4/project/platform-brand';

/** Timeout of the probe, ms: it runs after the retries failed and must not double the wait. */
export const PROBE_TIMEOUT = 3_000;

/** After a fallback that did not move the client, the next one is tried no sooner than this, ms. */
export const FALLBACK_PAUSE = 300_000;

/** Accepted distance between `X-Response-Timestamp` and the local clock, seconds. */
export const RESPONSE_TOLERANCE = 300;

/** Clock drift below this is network latency, above the cap is nonsense, seconds. */
export const MIN_CLOCK_DRIFT = 30;
export const MAX_CLOCK_DRIFT = 86_400;

const MIN_LIFETIME = 3_600;
const MAX_LIFETIME = 604_800;
const MAX_ORIGIN_LENGTH = 2_048;
const MAX_HOST_LENGTH = 253;

/**
 * https, a host name of two or more labels whose last label starts with a letter (so neither an IP
 * literal nor `localhost`), port 443 or none; no credentials, path, query or fragment.
 */
const HTTPS_ORIGIN = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])(?::443)?$/i;

/** http is for local development only: a loopback host, any port. */
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i;

/**
 * Checks the API origin a fallback host returned. The check runs on the raw string, without a URL
 * parser, so every official SDK accepts exactly the same values.
 *
 * @returns the normalized origin (lower case, no default port), or `null` when it is not acceptable.
 */
export function acceptOrigin(value: unknown, allowLoopbackHttp: boolean): string | null {
  if (typeof value !== 'string' || value.length > MAX_ORIGIN_LENGTH) {
    return null;
  }
  const https = HTTPS_ORIGIN.exec(value);
  if (https !== null) {
    const host = (https[1] as string).toLowerCase();
    if (host.length > MAX_HOST_LENGTH || host.endsWith('.local') || host.endsWith('.localhost')) {
      return null;
    }
    return `https://${host}`;
  }
  const http = allowLoopbackHttp ? LOOPBACK_ORIGIN.exec(value) : null;
  if (http !== null) {
    const port = http[2];
    return `http://${(http[1] as string).toLowerCase()}${port === undefined || port === '80' ? '' : `:${port}`}`;
  }
  return null;
}

/** How long a new origin is remembered, seconds: `refresh_after` of the response within 1 hour … 7 days. */
export function originLifetime(refreshAfter: unknown): number {
  if (typeof refreshAfter !== 'number' || !Number.isInteger(refreshAfter)) {
    return MIN_LIFETIME;
  }
  return Math.min(MAX_LIFETIME, Math.max(MIN_LIFETIME, refreshAfter));
}
