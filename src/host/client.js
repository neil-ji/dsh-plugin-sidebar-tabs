/**
 * Host half of dsh-plugin-sidebar-tabs.
 *
 * The tab-management half of this plugin lives entirely in the browser surface.
 * The media preview needs a second thing from the Host: a URL a `<video>`
 * element can stream from.
 *
 * Inline previews read file content through `remote.workspaceFiles`, whose
 * complete-file read is capped (32 MiB by default) and hands back base64 — fine
 * for a PDF or a screenshot, useless for a movie. So this half registers one
 * HTTP route pair on the composition's `webServer`:
 *
 *   POST <sign path>   — authorize one Session file, answer a signed stream URL
 *   GET  <stream path> — serve that file as bytes, honouring `Range`
 *
 * The reading itself is delegated back to the same `workspaceFiles` Host service
 * the rest of the preview surface uses, one byte window at a time. That is
 * deliberate: the composed filesystem, not this plugin, decides what a Session
 * is allowed to read, and the byte-window cap bounds how much is ever in memory.
 * Nothing here opens a file directly.
 *
 * Authorization is the token, not the route. A media element cannot attach an
 * `Authorization` header, so the URL carries an HMAC-signed grant bound to one
 * Session and one resolved path, expiring on its own.
 *
 * The three modules under `src/host/` are inlined into this file by
 * `tools/build.mjs`, so `bytesOf`, `createSecret`, `DEFAULT_TOKEN_TTL_MS`,
 * `mediaTypeOf`, `parseByteRange`, `signMediaToken`, and `verifyMediaToken` are
 * defined below in the same module scope rather than imported.
 */

/** Cordis plugin name; stable because the profile patch row refers to the package. */
export const name = 'sidebarTabs';

/**
 * Services the media routes need. A missing one fails this half's registration;
 * the browser half is unaffected, because it is a separate bundle.
 */
export const inject = ['webServer', 'workspaceFiles', 'typert'];

/** Where a signed stream URL is minted from. */
const SIGN_PATH = '/api/sidebar-tabs/media/sign';
/** Where bytes are streamed from; the signed token rides in the query string. */
const STREAM_PATH = '/api/sidebar-tabs/media/stream';
/** Cap on the JSON body of one sign request. */
const MAX_BODY_BYTES = 8192;
/** First byte-window size to try; halved on refusal down to the floor below. */
const FIRST_CHUNK_BYTES = 1024 * 1024;
/** Smallest byte window worth asking for; a cap below this is not worth adapting to. */
const MIN_CHUNK_BYTES = 4096;

/**
 * Read the one configurable number this half honours.
 *
 * The config arrives as `apply`'s second argument, never through `ctx.config`:
 * Cordis refuses that property access on a context whose plugin did not declare
 * it, and the throw aborts the whole `apply` — which reads in the profile as a
 * plugin that silently mounted nothing. A missing or nonsensical value falls
 * back to the default rather than failing the routes.
 * @param config - the loader row's config, if any.
 * @returns the signed-URL lifetime in milliseconds.
 */
function tokenTtlOf(config) {
  const value = config?.mediaTokenTtlMs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TOKEN_TTL_MS;
  return value;
}

/** Answer with a small JSON body. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

/** Reject a request whose method the route does not implement. */
function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed);
  sendJson(res, 405, { error: 'method-not-allowed', allow: allowed });
}

/** Read and parse one bounded JSON request body. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve({ error: 'body-too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(text);
        resolve(parsed !== null && typeof parsed === 'object' ? { value: parsed } : { error: 'bad-body' });
      } catch {
        resolve({ error: 'bad-body' });
      }
    });
    req.on('error', () => resolve({ error: 'bad-body' }));
  });
}

/**
 * Mount the Host half.
 * @param ctx - Host root context carrying the web server, the file service, and the lookup registry.
 * @param config - this row's config; only the signed-URL lifetime is honoured.
 */
export function apply(ctx, config) {
  const secret = createSecret();
  const log = (message, error) => {
    if (error === undefined) ctx.logger?.info?.(`[${name}] ${message}`);
    else ctx.logger?.warn?.(`[${name}] ${message}`, error);
  };
  const ttlMs = tokenTtlOf(config);
  log(`media routes mounting — POST ${SIGN_PATH}, GET ${STREAM_PATH}, ttl ${ttlMs}ms`);

  /** The Session-to-workspace-root adapter the Remote wire itself uses. */
  const scopeProvider = () => ctx.typert?.lookups?.get?.('workspaceFileScope');

  /**
   * Resolve one Session file to its Host path and byte size.
   *
   * The scope adapter — not this plugin — decides how a Session id becomes a
   * workspace root, so a relative path resolves against exactly the root the
   * preview surface sees. The one-byte window is what reports the size and the
   * resolved absolute path back.
   * @param sessionId - Session identity from the sign request.
   * @param path - workspace-relative or absolute path from the sign request.
   * @returns the resolved path and size, or a refusal reason.
   */
  const resolveFile = async (sessionId, path) => {
    const provider = scopeProvider();
    if (provider === undefined) return { error: 'scope-unavailable' };
    let scope;
    try {
      scope = await provider.resolve(sessionId);
    } catch (error) {
      log(`workspace scope lookup failed for ${sessionId}`, error);
      return { error: 'scope-failed' };
    }
    if (scope === undefined) return { error: 'unknown-session' };
    let window;
    try {
      window = await ctx.workspaceFiles.readBytes(scope, path, { offset: 0, length: 1 }, new AbortController().signal);
    } catch (error) {
      return { error: 'unreadable', detail: error?.code ?? String(error?.message ?? error) };
    }
    if (typeof window.bytes !== 'number') return { error: 'unknown-size' };
    if (window.bytes <= 0) return { error: 'empty' };
    return { scope, absolutePath: window.absolutePath, bytes: window.bytes };
  };

  /** Route: authorize one file and answer a signed, expiring stream URL. */
  const disposeSign = ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SIGN_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            methodNotAllowed(res, 'POST');
            return;
          }
          const body = await readJsonBody(req);
          if (body.value === undefined) {
            sendJson(res, 400, { error: body.error });
            return;
          }
          const { sessionId, path } = body.value;
          if (typeof sessionId !== 'string' || sessionId === '' || typeof path !== 'string' || path === '') {
            sendJson(res, 400, { error: 'bad-request', detail: 'sessionId and path are required' });
            return;
          }
          const resolved = await resolveFile(sessionId, path);
          if (resolved.error !== undefined) {
            sendJson(res, resolved.error === 'unreadable' ? 404 : 409, { error: resolved.error, detail: resolved.detail });
            return;
          }
          const mediaType = mediaTypeOf(resolved.absolutePath);
          if (mediaType === undefined) {
            sendJson(res, 415, { error: 'unsupported-media', path: resolved.absolutePath });
            return;
          }
          const token = signMediaToken(
            secret,
            { sessionId, path: resolved.absolutePath },
            { now: Date.now(), ttlMs },
          );
          sendJson(res, 200, {
            url: `${STREAM_PATH}?token=${encodeURIComponent(token)}`,
            mediaType,
            bytes: resolved.bytes,
          });
        },
      }),
    `${name}: POST ${SIGN_PATH}`,
  );

  /**
   * Route: stream one authorized file.
   *
   * `HEAD` is answered from the metadata read alone, so a media element can
   * learn the length and range support before asking for bytes; `GET` serves the
   * requested window, or the whole file when no `Range` arrived. Windows are
   * pulled one at a time and the response is paced by write backpressure, so
   * memory stays bounded however large the file is.
   */
  const disposeStream = ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: STREAM_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            methodNotAllowed(res, 'GET, HEAD');
            return;
          }
          const verdict = verifyMediaToken(secret, new URL(String(req.url), 'http://localhost').searchParams.get('token'), Date.now());
          if (!verdict.ok) {
            sendJson(res, 403, { error: 'forbidden', reason: verdict.reason });
            return;
          }
          const provider = scopeProvider();
          if (provider === undefined) {
            sendJson(res, 503, { error: 'scope-unavailable' });
            return;
          }
          let scope;
          try {
            scope = await provider.resolve(verdict.sessionId);
          } catch (error) {
            log('workspace scope lookup failed while streaming', error);
            sendJson(res, 502, { error: 'scope-failed' });
            return;
          }
          if (scope === undefined) {
            sendJson(res, 404, { error: 'unknown-session' });
            return;
          }

          const controller = new AbortController();
          res.on('close', () => controller.abort());
          const readWindow = (offset, length) =>
            ctx.workspaceFiles.readBytes(scope, verdict.path, { offset, length }, controller.signal);

          // Commit no response head until the size is known.
          let first;
          try {
            first = await readWindow(0, 1);
          } catch (error) {
            sendJson(res, 404, { error: 'unreadable', detail: error?.code ?? String(error?.message ?? error) });
            return;
          }
          const size = first.bytes;
          if (typeof size !== 'number' || size <= 0) {
            sendJson(res, 404, { error: 'empty-or-unknown-size' });
            return;
          }
          const mediaType = mediaTypeOf(verdict.path);
          if (mediaType === undefined) {
            sendJson(res, 415, { error: 'unsupported-media' });
            return;
          }

          const range = req.headers.range;
          const window = range === undefined ? { start: 0, end: size - 1 } : parseByteRange(range, size);
          if (window === undefined) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${size}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.end();
            return;
          }

          res.statusCode = range === undefined ? 200 : 206;
          res.setHeader('Content-Type', mediaType);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', String(window.end - window.start + 1));
          res.setHeader('Cache-Control', 'no-store');
          if (range !== undefined) res.setHeader('Content-Range', `bytes ${window.start}-${window.end}/${size}`);
          if (req.method === 'HEAD') {
            res.end();
            return;
          }

          const write = (chunk) =>
            new Promise((resolve) => {
              if (res.write(chunk)) resolve(true);
              else res.once('drain', () => resolve(true));
            });

          try {
            let offset = window.start;
            // The byte-window cap belongs to the file service's configuration, so
            // it is discovered rather than assumed: a window above it is refused
            // (never shortened), and the refusal names no safe size. Start well
            // under the shipped default, then halve on each refusal and keep the
            // size that worked for the rest of the response.
            let width = FIRST_CHUNK_BYTES;
            let part;
            while (offset <= window.end && !controller.signal.aborted) {
              const wanted = Math.min(window.end - offset + 1, size - offset);
              if (wanted <= 0) break;
              try {
                part = await readWindow(offset, Math.min(wanted, width));
              } catch (error) {
                const tooLarge = error?.code === 'workspace-file/too-large' || error?.limit !== undefined;
                if (!tooLarge || width <= MIN_CHUNK_BYTES) throw error;
                width = Math.max(MIN_CHUNK_BYTES, Math.floor(width / 2));
                continue;
              }
              const chunk = bytesOf(part.data);
              if (chunk.length === 0) break;
              if (!(await write(chunk))) break;
              offset += chunk.length;
            }
            res.end();
          } catch (error) {
            if (!controller.signal.aborted) log(`stream of ${verdict.path} failed`, error);
            res.destroy();
          }
        },
      }),
    `${name}: GET ${STREAM_PATH}`,
  );

  ctx.effect(() => () => {
    disposeStream();
    disposeSign();
  });
}
