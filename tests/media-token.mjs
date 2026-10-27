/**
 * Unit tests for the media-preview Host primitives.
 *
 * These cover the two places where a mistake is invisible until a real browser
 * hits it: the token decides whether a stream request is authorized at all, and
 * the range grammar decides whether a `<video>` element can seek. Both are pure,
 * so neither needs a Host, a Session, or a socket.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { createSecret, DEFAULT_TOKEN_TTL_MS, signMediaToken, verifyMediaToken } from '../src/host/media-token.js';
import { parseByteRange } from '../src/host/media-range.js';
import { bytesOf, mediaTypeOf, MEDIA_EXTENSIONS } from '../src/host/media-types.js';

const NOW = 1_700_000_000_000;
const secret = createSecret();
const grant = { sessionId: 'session-abc', path: '/tmp/media/clip.mp4' };
const sign = (overrides = {}) =>
  signMediaToken(secret, { ...grant, ...overrides.grant }, {
    now: overrides.now ?? NOW,
    ttlMs: overrides.ttlMs ?? DEFAULT_TOKEN_TTL_MS,
  });

test('a freshly signed token verifies back to its grant', () => {
  const token = sign();
  const verdict = verifyMediaToken(secret, token, NOW + 1);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.sessionId, grant.sessionId);
  assert.equal(verdict.path, grant.path);
  assert.equal(verdict.expiresAt, NOW + DEFAULT_TOKEN_TTL_MS);
});

test('two tokens for the same file differ, so a re-request is never a cache hit', () => {
  assert.notEqual(sign(), sign());
});

test('an expired token is refused', () => {
  const token = sign({ ttlMs: 1000 });
  const verdict = verifyMediaToken(secret, token, NOW + 1001);
  assert.deepEqual(verdict, { ok: false, reason: 'expired' });
});

test('a token that expires exactly now is refused', () => {
  const token = sign({ ttlMs: 1000 });
  assert.equal(verifyMediaToken(secret, token, NOW + 1000).ok, false);
});

test('an edited payload invalidates the tag', () => {
  const token = sign();
  const [body, tag] = token.split('.');
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  forged.path = '/etc/passwd';
  const edited = `${Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url')}.${tag}`;
  assert.deepEqual(verifyMediaToken(secret, edited, NOW + 1), { ok: false, reason: 'signature' });
});

test('an edited tag is refused', () => {
  const token = sign();
  const [body] = token.split('.');
  assert.equal(verifyMediaToken(secret, `${body}.AAAA`, NOW + 1).ok, false);
});

test('another process secret cannot verify the token', () => {
  assert.deepEqual(verifyMediaToken(createSecret(), sign(), NOW + 1), { ok: false, reason: 'signature' });
});

test('malformed and missing tokens are refused without throwing', () => {
  for (const bad of ['', 'no-dot', '.', 'body.', 'not base64!!.tag', null, undefined, 42]) {
    const verdict = verifyMediaToken(secret, bad, NOW + 1);
    assert.equal(verdict.ok, false, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('a correctly signed payload with the wrong shape is refused', () => {
  for (const payload of [{}, { session: 's' }, { session: 's', path: '/a' }, { session: 's', path: '/a', exp: 'soon' }]) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const token = `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
    assert.equal(verifyMediaToken(secret, token, NOW).ok, false, `expected ${JSON.stringify(payload)} to be refused`);
  }
});

test('a closed range is honoured verbatim', () => {
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=500-999', 1000), { start: 500, end: 999 });
});

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseByteRange('bytes=200-', 1000), { start: 200, end: 999 });
  assert.deepEqual(parseByteRange('bytes=0-', 1), { start: 0, end: 0 });
});

test('a suffix range takes the final bytes', () => {
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-5000', 1000), { start: 0, end: 999 });
});

test('an end past the file is clamped rather than refused', () => {
  assert.deepEqual(parseByteRange('bytes=900-99999', 1000), { start: 900, end: 999 });
});

test('unsatisfiable ranges are reported as such', () => {
  for (const header of ['bytes=1000-', 'bytes=2000-3000', 'bytes=500-100', 'bytes=-0', 'bytes=-', 'items=0-10', 'bytes=abc-def', 'bytes=0-10,20-30']) {
    assert.equal(parseByteRange(header, 1000), undefined, `expected ${header} to be unsatisfiable`);
  }
});

test('an empty file satisfies no range', () => {
  assert.equal(parseByteRange('bytes=0-', 0), undefined);
  assert.equal(parseByteRange('bytes=-10', 0), undefined);
});

test('a missing or non-string header asks for the whole file elsewhere', () => {
  assert.equal(parseByteRange(undefined, 1000), undefined);
  assert.equal(parseByteRange(null, 1000), undefined);
});

test('media types resolve by extension, case-insensitively', () => {
  assert.equal(mediaTypeOf('/a/b/clip.mp4'), 'video/mp4');
  assert.equal(mediaTypeOf('C:\\media\\CLIP.MOV'), 'video/quicktime');
  assert.equal(mediaTypeOf('song.M4A'), 'audio/mp4');
  assert.equal(mediaTypeOf('notes.md'), undefined);
  assert.equal(mediaTypeOf('.mp4'), undefined);
  assert.equal(mediaTypeOf('mp4'), undefined);
});

test('the advertised extension list matches the media table', () => {
  for (const extension of MEDIA_EXTENSIONS) {
    assert.notEqual(mediaTypeOf(`file.${extension}`), undefined, `${extension} must resolve`);
  }
  assert.ok(MEDIA_EXTENSIONS.includes('mp4'));
  assert.ok(MEDIA_EXTENSIONS.includes('mp3'));
});

test('a byte window keeps its bytes, whichever shape it arrives in', () => {
  const original = Buffer.from([0x00, 0xff, 0x10, 0x7f]);
  assert.deepEqual(bytesOf(original.toString('base64')), original);
  // The in-process service returns native bytes, and treating those as base64
  // text is what turned every streamed byte into garbage.
  assert.deepEqual(bytesOf(original), original);
  assert.deepEqual(bytesOf(new Uint8Array(original)), original);
  assert.deepEqual(bytesOf(original.buffer.slice(original.byteOffset, original.byteOffset + original.length)), original);
  assert.equal(bytesOf('').length, 0);
});
