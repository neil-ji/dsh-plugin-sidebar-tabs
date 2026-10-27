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
/** Read-only view of what the other two routes have been asked to do. */
const STATUS_PATH = '/api/sidebar-tabs/media/status';
/** Cap on the JSON body of one sign request. */
const MAX_BODY_BYTES = 8192;
/** First byte-window size to try; halved on refusal down to the floor below. */
const FIRST_CHUNK_BYTES = 1024 * 1024;
/** Smallest byte window worth asking for; a cap below this is not worth adapting to. */
const MIN_CHUNK_BYTES = 4096;
/** How many recent requests the status route remembers. */
const JOURNAL_LIMIT = 40;

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

/**
 * A bounded, read-only record of what the media routes were asked to do.
 *
 * A stalled `<video>` is invisible from this side of the socket: the browser
 * decides by itself which ranges to ask for, and whether it ever asked is the
 * first thing worth knowing. The journal keeps that answer, without paths or
 * tokens, behind a GET route on the same trust fence as the rest of the API.
 * @returns the recorder and the snapshot reader.
 */
function createJournal() {
  const entries = [];
  const counts = { sign: 0, signFailed: 0, stream: 0, streamFailed: 0, refused: 0 };
  return {
    /** Append one entry, dropping the oldest past the limit. */
    add(entry) {
      counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
      entries.unshift({ at: new Date().toISOString(), ...entry });
      if (entries.length > JOURNAL_LIMIT) entries.length = JOURNAL_LIMIT;
    },
    /** Note a refusal the route answered instead of serving. */
    refuse(kind, reason) {
      counts.refused += 1;
      counts[kind === 'sign' ? 'signFailed' : 'streamFailed'] += 1;
      this.add({ kind: `${kind}-refused`, reason });
    },
    /** @returns the counters and the most recent entries, newest first. */
    snapshot() {
      return { counts, entries };
    },
  };
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
  const journal = createJournal();
  const ttlMs = tokenTtlOf(config);
  log(`media routes mounting — POST ${SIGN_PATH}, GET ${STREAM_PATH}, GET ${STATUS_PATH}, ttl ${ttlMs}ms`);

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
      // A byte window, not a complete read: `readBytes` applies `maxFileBytes`
      // (32 MiB by default) to the complete form and refuses anything larger, so
      // the size probe and the stream would both fail on exactly the files this
      // half exists for. The window cap `maxBytes` is the one that applies here.
      window = await ctx.workspaceFiles.readBytes(
        scope,
        path,
        { range: { offset: 0, length: 1 } },
        new AbortController().signal,
      );
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
            journal.refuse('sign', 'bad-request');
            sendJson(res, 400, { error: 'bad-request', detail: 'sessionId and path are required' });
            return;
          }
          const resolved = await resolveFile(sessionId, path);
          if (resolved.error !== undefined) {
            journal.refuse('sign', resolved.error);
            sendJson(res, resolved.error === 'unreadable' ? 404 : 409, { error: resolved.error, detail: resolved.detail });
            return;
          }
          const mediaType = mediaTypeOf(resolved.absolutePath);
          if (mediaType === undefined) {
            journal.refuse('sign', 'unsupported-media');
            sendJson(res, 415, { error: 'unsupported-media', path: resolved.absolutePath });
            return;
          }
          journal.add({ kind: 'sign', name: resolved.absolutePath.split('/').pop(), bytes: resolved.bytes, mediaType });
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
            journal.refuse('stream', `token-${verdict.reason}`);
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
          // The options shape is the service's, not this plugin's: a window is
          // `{ range: { offset, length } }`. Passing `{ offset, length }` asks for
          // the *complete* file instead — refused above `maxFileBytes` and, below
          // it, one whole file per request instead of one window, which is what
          // made every streamed byte arrive with the container's offsets lost.
          const readWindow = (offset, length) =>
            ctx.workspaceFiles.readBytes(scope, verdict.path, { range: { offset, length } }, controller.signal);

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
          // Request-side visibility is what makes a stalled media element
          // diagnosable: the browser decides on its own which ranges to ask for,
          // and a request this route answers differently than the element expects
          // is invisible from the response side alone.
          log(
            `stream ${req.method} ${verdict.path.split('/').pop()} range=${range ?? '(none)'} size=${size} -> ` +
              (window === undefined ? '416' : `${window.start}-${window.end} (${window.end - window.start + 1}B)`),
          );
          journal.add({
            kind: 'stream',
            method: req.method,
            name: verdict.path.split('/').pop(),
            range: range ?? null,
            // The status the response will carry: a plain whole-file request is a
            // 200, and reporting it as 206 made the journal misdescribe the very
            // case worth diagnosing.
            status: window === undefined ? 416 : range === undefined ? 200 : 206,
            from: window?.start ?? null,
            to: window?.end ?? null,
          });
          if (window === undefined) journal.refuse('stream', 'unsatisfiable-range');
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

  /**
   * Route: report what the other two routes have been asked to do.
   *
   * Read-only, path- and token-free, and on the same trust fence as every other
   * `/api` route: it exists so a stalled player can be diagnosed from the app it
   * is stalling in, instead of by reproducing it elsewhere.
   */
  const disposeStatus = ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            methodNotAllowed(res, 'GET');
            return;
          }
          sendJson(res, 200, {
            ttlMs,
            streamPath: STREAM_PATH,
            signPath: SIGN_PATH,
            ...journal.snapshot(),
          });
        },
      }),
    `${name}: GET ${STATUS_PATH}`,
  );

  ctx.effect(() => () => {
    disposeStatus();
    disposeStream();
    disposeSign();
  });
}
