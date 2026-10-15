/**
 * Signed stream tokens for the media preview.
 *
 * The browser's `<video>` element cannot send an `Authorization` header, so the
 * URL itself has to carry the grant — which means the grant must be unforgeable
 * rather than merely obscure. A token is a base64url payload plus an HMAC-SHA256
 * tag over that payload, keyed by a secret generated per Host process: tampering
 * invalidates the tag, and a restart invalidates every outstanding URL.
 *
 * `tools/build.mjs` inlines this file into one `lib/index.js` and strips the
 * import above it, so it must stay free of module-level state and of any
 * dependency beyond the Node builtin it names.
 */

import crypto from 'node:crypto';

/** How long a signed URL stays usable by default; one long viewing session. */
export const DEFAULT_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

/** A fresh signing secret for one Host process. */
export function createSecret() {
  return crypto.randomBytes(32);
}

/** HMAC-SHA256 of `payload`, as unpadded base64url. */
function tagOf(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Constant-time comparison of two base64url tags. */
function sameTag(left, right) {
  const a = Buffer.from(left, 'base64url');
  const b = Buffer.from(right, 'base64url');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sign one grant for a Session file.
 * @param secret - the process signing secret.
 * @param grant - Session identity and Host-resolved path to authorize.
 * @param options - issue time and lifetime.
 * @returns the token to place in the stream URL's query string.
 */
export function signMediaToken(secret, grant, options) {
  const payload = {
    session: grant.sessionId,
    path: grant.path,
    exp: options.now + options.ttlMs,
    nonce: crypto.randomBytes(12).toString('base64url'),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${tagOf(secret, body)}`;
}

/**
 * Verify one token and return its grant.
 * @param secret - the process signing secret.
 * @param token - the query-string token, which is untrusted input.
 * @param now - current epoch milliseconds, injected so expiry is testable.
 * @returns the payload, or a reason the token is unusable.
 */
export function verifyMediaToken(secret, token, now) {
  if (typeof token !== 'string' || token === '') return { ok: false, reason: 'missing' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const tag = token.slice(dot + 1);
  if (!sameTag(tagOf(secret, body), tag)) return { ok: false, reason: 'signature' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload === null || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  if (typeof payload.session !== 'string' || payload.session === '') return { ok: false, reason: 'malformed' };
  if (typeof payload.path !== 'string' || payload.path === '') return { ok: false, reason: 'malformed' };
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return { ok: false, reason: 'malformed' };
  if (payload.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, sessionId: payload.session, path: payload.path, expiresAt: payload.exp };
}
