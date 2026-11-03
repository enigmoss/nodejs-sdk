const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Decodes lowercase or uppercase hex; `null` when the text is not hex of an even length. */
export function unhex(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) {
    return null;
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function hmacHex(key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', key, data));
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', utf8(text)));
}

/**
 * Signature of an API request: hex(HMAC-SHA256(key, "{timestamp}\n{project}\n{METHOD}\n{request uri}\n{body}")).
 * The request URI starts with "/api/v4" and carries the query exactly as sent; `body` is the exact
 * byte string sent on the wire (empty for GET).
 */
export function signRequest(
  key: CryptoKey,
  timestamp: number,
  projectId: string,
  method: string,
  requestUri: string,
  body: Uint8Array,
): Promise<string> {
  const head = utf8(`${timestamp}\n${projectId}\n${method.toUpperCase()}\n${requestUri}\n`);
  return hmacHex(key, concat(head, body));
}

/**
 * Default Idempotency-Key of a create call: "sdk1-" + the first 59 hex chars of
 * sha256(request uri + "\n" + order_id). Identical to the other official SDKs, so a create repeated
 * from any of them returns the stored response instead of a second object.
 */
export async function orderIdempotencyKey(requestUri: string, orderId: string): Promise<string> {
  return `sdk1-${(await sha256Hex(`${requestUri}\n${orderId}`)).slice(0, 59)}`;
}

/** PHP rawurlencode: everything except A-Z a-z 0-9 - _ . ~ is percent-encoded (UTF-8). */
export function rawUrlEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
