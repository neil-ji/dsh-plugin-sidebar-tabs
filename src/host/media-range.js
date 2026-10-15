/**
 * The HTTP `Range` grammar the media route honours.
 *
 * Only single-range requests are supported. A multipart byte range would cost
 * the client a parser for a response an HTML media element never asks for, since
 * it seeks with one range at a time; anything else is reported as unsatisfiable
 * and answered with 416, which is what the grammar asks for.
 *
 * `tools/build.mjs` inlines this file into the Host bundle, so it stays free of
 * imports and module-level state.
 */

/**
 * Parse one `Range` request header against a known file size.
 * @param header - the raw header value; other forms are rejected.
 * @param size - complete file size in bytes.
 * @returns inclusive byte offsets, or `undefined` when the request is unsatisfiable.
 */
export function parseByteRange(header, size) {
  if (typeof header !== 'string') return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return undefined;
  if (size <= 0) return undefined;
  if (rawStart === '') {
    // `bytes=-N`: the final N bytes, clamped to the whole file.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return undefined;
  if (rawEnd === '') return { start, end: size - 1 };
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return undefined;
  return { start, end: Math.min(end, size - 1) };
}
