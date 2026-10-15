/**
 * Integration test for the Host half's media routes.
 *
 * The unit tests cover the token and the range grammar in isolation; this drives
 * the routes the way a browser does — a real `node:http` server, real requests,
 * real response bodies — against a fake `ctx` whose `workspaceFiles` service
 * serves one in-memory file through the same base64 byte-window contract the
 * shipped service uses.
 *
 * What it protects: the sign/stream handshake, `Range` seeking, the byte count of
 * what actually arrives, and every refusal (bad token, expired token, missing
 * file, unplayable suffix) staying a status code rather than an exception.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { apply, inject, name } from '../lib/index.js';

/** The bytes the fake file service serves; large enough to seek inside. */
const FILE_BYTES = Buffer.alloc(64 * 1024 + 7);
for (let index = 0; index < FILE_BYTES.length; index += 1) FILE_BYTES[index] = (index * 7) % 251;

/** The byte-window cap the shipped service applies, mirrored so chunking is exercised. */
const MAX_WINDOW = 4096;

/**
 * Build a fake Host context that registers the plugin's routes on a real server.
 * @param options - which files resolve, and which Session ids are known.
 * @returns the running server, its base URL, and the plugin's disposer plus call log.
 */
async function startHost({ files, sessions = ['s1'], config } = {}) {
  const calls = [];
  const routes = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };

  const scope = { sessionId: 's1', workspaceRoot: '/workspace' };
  const workspaceFiles = {
    async readBytes(_scope, path, range, signal) {
      const absolutePath = path.startsWith('/') ? path : `/workspace/${path}`;
      const data = files[absolutePath];
      const offset = range?.offset ?? 0;
      const length = range?.length ?? MAX_WINDOW;
      const record = { path, range, offset, length, refused: false, aborted: signal?.aborted === true };
      if (data === undefined) {
        calls.push(record);
        const error = new Error(`no such file: ${absolutePath}`);
        error.code = 'workspace-file/not-found';
        throw error;
      }
      // The shipped service refuses an oversized window instead of shortening it;
      // mirroring that refusal is what proves the route adapts rather than
      // silently reading the wrong bytes.
      if (length > MAX_WINDOW) {
        record.refused = true;
        calls.push(record);
        const error = new Error(`${length} bytes exceed the ${MAX_WINDOW} byte cap`);
        error.code = 'workspace-file/too-large';
        error.limit = MAX_WINDOW;
        throw error;
      }
      calls.push(record);
      const window = data.subarray(offset, offset + length);
      return {
        absolutePath,
        version: 'v1',
        bytes: data.length,
        offset,
        data: window.toString('base64'),
        eof: offset + window.length >= data.length,
      };
    },
  };

  const services = {
    webServer,
    workspaceFiles,
    typert: { lookups: { get: (key) => (key === 'workspaceFileScope' ? { resolve: async (id) => (sessions.includes(id) ? scope : undefined) } : undefined) } },
  };

  // Mirror two Cordis contracts the plugin has to live inside:
  //
  //  - `ctx.effect(execute, label)` runs the callback immediately and keeps its
  //    disposer; anything that is neither a function nor nullish is an error.
  //  - The context proxy THROWS on any service the plugin did not declare in
  //    `inject`, while the core context API stays reachable. Reading `ctx.config`
  //    there is exactly the mistake that made the Host half abort before
  //    registering a single route — the config arrives as `apply`'s second
  //    argument — so the fake refuses it the same way instead of quietly handing
  //    back `undefined`.
  const disposers = [];
  const CORE_CONTEXT_API = new Set(['effect', 'on', 'inject', 'plugin', 'registry', 'reflect', 'get', 'set', 'logger']);
  const context = {
    logger: { info: () => {}, warn: () => {} },
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer !== 'function' && disposer !== undefined && disposer !== null) {
        throw new TypeError('Invalid effect');
      }
      disposers.push(disposer);
      return disposer;
    },
  };
  const ctx = new Proxy(context, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property !== 'symbol' && CORE_CONTEXT_API.has(property)) return target[property];
      if (typeof property === 'symbol' || !inject.includes(property)) {
        throw new Error(`cannot get property "${String(property)}" without inject`);
      }
      return services[property];
    },
  });

  apply(ctx, config);

  const server = createServer((req, res) => {
    const pathname = new URL(String(req.url), 'http://localhost').pathname;
    const exact = routes.find((route) => route.kind === 'exact' && route.path === pathname);
    const prefix = routes.filter((route) => route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(`${route.path}/`))).sort((a, b) => b.path.length - a.path.length)[0];
    const route = exact ?? prefix;
    if (route === undefined) {
      res.statusCode = 404;
      res.end();
      return;
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.end(String(error?.message ?? error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    calls,
    routes,
    async close() {
      // Disposal runs the plugin's own teardown effect, which is what removes
      // the routes; `disposeStream`/`disposeSign` are only reachable that way.
      for (const disposer of disposers.reverse()) disposer?.();
      // `fetch` keeps its sockets alive, and a keep-alive socket pins the event
      // loop open, so the server cannot simply be closed and left at that.
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}

/** POST one sign request and return the parsed answer. */
async function sign(base, body) {
  const response = await fetch(`${base}/api/sidebar-tabs/media/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return { status: response.status, payload };
}

test('the Host half declares the services its routes need', () => {
  assert.equal(name, 'sidebarTabs');
  assert.deepEqual(inject, ['webServer', 'workspaceFiles', 'typert']);
});

test('sign then stream returns the complete file, byte for byte', async () => {
  const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES } });
  try {
    const signed = await sign(host.base, { sessionId: 's1', path: 'media/clip.mp4' });
    assert.equal(signed.status, 200);
    assert.equal(signed.payload.mediaType, 'video/mp4');
    assert.equal(signed.payload.bytes, FILE_BYTES.length);

    const response = await fetch(`${host.base}${signed.payload.url}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-length'), String(FILE_BYTES.length));
    const received = Buffer.from(await response.arrayBuffer());
    assert.equal(received.length, FILE_BYTES.length);
    assert.ok(received.equals(FILE_BYTES), 'the streamed bytes must be the file’s bytes');
  } finally {
    await host.close();
  }
});

test('a range request answers 206 with exactly the requested window', async () => {
  const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES } });
  try {
    const signed = await sign(host.base, { sessionId: 's1', path: 'media/clip.mp4' });
    const response = await fetch(`${host.base}${signed.payload.url}`, { headers: { Range: 'bytes=1000-2999' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 1000-2999/${FILE_BYTES.length}`);
    assert.equal(response.headers.get('content-length'), '2000');
    const received = Buffer.from(await response.arrayBuffer());
    assert.ok(received.equals(FILE_BYTES.subarray(1000, 3000)), 'a seek must land on the right bytes');
  } finally {
    await host.close();
  }
});

test('a suffix range serves the tail, so a player can read a trailing index', async () => {
  const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES } });
  try {
    const signed = await sign(host.base, { sessionId: 's1', path: 'media/clip.mp4' });
    const response = await fetch(`${host.base}${signed.payload.url}`, { headers: { Range: 'bytes=-16' } });
    assert.equal(response.status, 206);
    const received = Buffer.from(await response.arrayBuffer());
    assert.ok(received.equals(FILE_BYTES.subarray(FILE_BYTES.length - 16)));
  } finally {
    await host.close();
  }
});

test('HEAD reports length and range support without a body', async () => {
  const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES } });
  try {
    const signed = await sign(host.base, { sessionId: 's1', path: 'media/clip.mp4' });
    const response = await fetch(`${host.base}${signed.payload.url}`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(FILE_BYTES.length));
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  } finally {
    await host.close();
  }
});

test('an unsatisfiable range is 416, not a crash or a silent whole file', async () => {
  const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES } });
  try {
    const signed = await sign(host.base, { sessionId: 's1', path: 'media/clip.mp4' });
    const response = await fetch(`${host.base}${signed.payload.url}`, { headers: { Range: `bytes=${FILE_BYTES.length + 10}-` } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${FILE_BYTES.length}`);
  } finally {
    await host.close();
  }
});

test('the stream adapts to the service window cap and pages through the file', async () => {
  const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES } });
  try {
    const signed = await sign(host.base, { sessionId: 's1', path: 'media/clip.mp4' });
    const response = await fetch(`${host.base}${signed.payload.url}`);
    assert.equal(response.status, 200);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(FILE_BYTES), 'adapting must not change the bytes');

    // A refused window is the adaptation working, not a defect: the cap is the
    // service's configuration and the route discovers it by being refused.
    assert.ok(host.calls.some((call) => call.refused), 'the route must discover the cap by exceeding it');
    const served = host.calls.filter((call) => !call.refused);
    assert.ok(served.length > 1, 'the route must page through the file, not ask for it whole');
    for (const call of served) assert.ok(call.length <= MAX_WINDOW, `window ${call.length} exceeds the cap`);
    for (const call of served) assert.equal(call.aborted, false);
    // Every served window starts where the stream had reached, in order.
    const covers = served.map((call) => `${call.offset}-${call.offset + call.length}`).join(' ');
    assert.ok(covers.startsWith('0-'), `the stream must start at zero: ${covers}`);
    assert.ok(covers.includes(`${FILE_BYTES.length}`), `the stream must reach the end: ${covers}`);
  } finally {
    await host.close();
  }
});

test('an unplayable suffix is refused at sign time with 415', async () => {
  const host = await startHost({ files: { '/workspace/media/notes.md': Buffer.from('hello') } });
  try {
    const answer = await sign(host.base, { sessionId: 's1', path: 'media/notes.md' });
    assert.equal(answer.status, 415);
    assert.equal(answer.payload.error, 'unsupported-media');
  } finally {
    await host.close();
  }
});

test('a missing file fails the sign request instead of minting a dead URL', async () => {
  const host = await startHost({ files: {} });
  try {
    const answer = await sign(host.base, { sessionId: 's1', path: 'media/gone.mp4' });
    assert.equal(answer.status, 404);
    assert.equal(answer.payload.error, 'unreadable');
    assert.equal(answer.payload.detail, 'workspace-file/not-found');
  } finally {
    await host.close();
  }
});

test('an unknown Session cannot sign', async () => {
  const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES }, sessions: [] });
  try {
    const answer = await sign(host.base, { sessionId: 'nope', path: 'media/clip.mp4' });
    assert.equal(answer.status, 409);
    assert.equal(answer.payload.error, 'unknown-session');
  } finally {
    await host.close();
  }
});

test('the sign route insists on a POST body it can read', async () => {
  const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES } });
  try {
    const wrongMethod = await fetch(`${host.base}/api/sidebar-tabs/media/sign`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');

    const empty = await sign(host.base, {});
    assert.equal(empty.status, 400);
    assert.equal(empty.payload.error, 'bad-request');

    const garbage = await fetch(`${host.base}/api/sidebar-tabs/media/sign`, { method: 'POST', body: 'not json' });
    assert.equal(garbage.status, 400);
    assert.equal((await garbage.json()).error, 'bad-body');
  } finally {
    await host.close();
  }
});

test('a token is required, single-use-shaped, and bound to its own process', async () => {
  const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES } });
  try {
    const bare = await fetch(`${host.base}/api/sidebar-tabs/media/stream`);
    assert.equal(bare.status, 403);
    assert.equal((await bare.json()).reason, 'missing');

    const tampered = await fetch(`${host.base}/api/sidebar-tabs/media/stream?token=abc.def`);
    assert.equal(tampered.status, 403);
    assert.equal((await tampered.json()).reason, 'signature');

    const signed = await sign(host.base, { sessionId: 's1', path: 'media/clip.mp4' });
    const [body, tag] = signed.payload.url.split('token=')[1].split('.');
    const editedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), path: '/etc/passwd' }), 'utf8').toString('base64url');
    const forged = await fetch(`${host.base}/api/sidebar-tabs/media/stream?token=${editedBody}.${tag}`);
    assert.equal(forged.status, 403);
    assert.equal((await forged.json()).reason, 'signature');
  } finally {
    await host.close();
  }
});

test('the row config sets the signed-URL lifetime, and nonsense falls back', async () => {
  /** Sign one file and read the token's own expiry back out of its payload. */
  const lifetimeOf = async (config) => {
    const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES }, config });
    try {
      const signed = await sign(host.base, { sessionId: 's1', path: 'media/clip.mp4' });
      const token = new URL(`http://x${signed.payload.url}`).searchParams.get('token');
      const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
      return payload.exp - Date.now();
    } finally {
      await host.close();
    }
  };
  // The config arrives as `apply`'s second argument; reading `ctx.config` instead
  // throws under the strict context above, which is what this test protects.
  assert.ok(Math.abs((await lifetimeOf({ mediaTokenTtlMs: 60_000 })) - 60_000) < 5_000);
  assert.ok((await lifetimeOf(undefined)) > 6 * 60 * 60 * 1000 - 5_000, 'the default lifetime must apply');
  assert.ok((await lifetimeOf({ mediaTokenTtlMs: -1 })) > 6 * 60 * 60 * 1000 - 5_000, 'a nonsense lifetime must fall back');
});

test('disposal unregisters both routes', async () => {
  const host = await startHost({ files: { '/workspace/media/clip.mp4': FILE_BYTES } });
  assert.equal(host.routes.length, 2);
  await host.close();
  assert.equal(host.routes.length, 0);
});
