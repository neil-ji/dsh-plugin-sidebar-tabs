/**
 * Which file suffixes the media preview streams, and as what.
 *
 * The table is the browser's, not the container's: every entry here is a format
 * the shipped web shell can play inline through a native `<video>` or `<audio>`
 * element. A suffix that is absent keeps the plain-text fallback the document
 * preview would have used anyway, which is a better answer than a player that
 * fails on every byte.
 *
 * `tools/build.mjs` inlines this file into the Host bundle, so it stays free of
 * imports and module-level state.
 */

/** Media type per lowercase extension. */
const MEDIA_TYPES = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['webm', 'video/webm'],
  ['ogv', 'video/ogg'],
  ['mov', 'video/quicktime'],
  ['mkv', 'video/x-matroska'],
  ['avi', 'video/x-msvideo'],
  ['mp3', 'audio/mpeg'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['wav', 'audio/wav'],
  ['flac', 'audio/flac'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/ogg'],
]);

/** Every extension this plugin is willing to stream. */
export const MEDIA_EXTENSIONS = [...MEDIA_TYPES.keys()];

/**
 * Media type for a path, by extension.
 * @param path - any file path or basename.
 * @returns the media type, or `undefined` for a suffix this plugin does not stream.
 */
export function mediaTypeOf(path) {
  const name = String(path).replaceAll('\\', '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return MEDIA_TYPES.get(name.slice(dot + 1).toLowerCase());
}

/**
 * Decode the base64 window a Host byte read returns.
 * @param data - base64 text from the workspace-files service.
 * @returns the raw bytes.
 */
export function bytesOf(data) {
  return Buffer.from(String(data), 'base64');
}
