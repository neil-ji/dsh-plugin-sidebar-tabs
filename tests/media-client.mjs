/**
 * Behaviour tests for the client half of the media preview.
 *
 * The bundle's address parser and suffix table are the two decisions a browser
 * never gets to explain: a mis-parsed address asks the Host to authorize the
 * wrong path, and a missing suffix silently drops the file back to the
 * plain-text reader. Both are pure, so this file evaluates the media region of
 * `src/client.js` directly instead of standing up a DOM.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/client.js'), 'utf8');

/** The media region of the client fragment, which is self-contained by design. */
const region = (() => {
  const start = source.indexOf('//#region media renderers');
  const end = source.indexOf('//#endregion', start);
  assert.ok(start > 0 && end > start, 'src/client.js must keep its media-renderer region');
  return source.slice(start, end);
})();

/**
 * Evaluate the media region with the same stand-ins the bundle's loader supplies.
 * @returns the pure decisions that region exports, plus its id and suffix list.
 */
function loadMediaRegion() {
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }), useMemo: (fn) => fn(), useState: (value) => [value, () => {}], useEffect: () => {} };
  const factory = new Function(
    'React',
    'h',
    'PLUGIN_ID',
    'NS',
    'fetch',
    'console',
    `${region}\nreturn { MEDIA_ID, MEDIA_SUFFIXES, MEDIA_TYPES, parseFileAddress, mediaTypeOf, baseNameOf, mediaDefinition, MediaBody };`,
  );
  return factory(react, react.createElement, 'dsh-plugin-sidebar-tabs', 'sidebarTabs', () => {}, { info: () => {}, warn: () => {} });
}

const media = loadMediaRegion();

/**
 * A React stand-in that actually runs: `useState` re-renders the caller,
 * `useEffect` runs on mount and its cleanup runs on unmount.
 *
 * The media body's whole job happens inside one effect — it asks the Host for a
 * signed URL and switches the element to it — so a stub that never runs an
 * effect could not tell a working body from a broken one.
 * @returns the hooks, plus `mount` to render a component and `unmount` to run cleanups.
 */
function makeInteractiveReact() {
  let states = [];
  let ranEffects = [];
  let cleanups = [];
  let renderCount = 0;
  let rendering = false;
  let index = 0;
  let rendered;

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useMemo: (fn) => fn(),
    useState(initial) {
      const slot = index;
      index += 1;
      if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
      return [
        states[slot],
        (next) => {
          const value = typeof next === 'function' ? next(states[slot]) : next;
          // A setter must not re-render from inside a render pass, and it must
          // not re-render when the value is unchanged — both are what React does
          // and both are what keep a mistaken state write from looping here.
          if (rendering || Object.is(value, states[slot])) return;
          states[slot] = value;
          render();
        },
      ];
    },
    useEffect(fn) {
      // A mounted component runs an effect once; the media body re-runs its own
      // effect only when its dependencies change, which this harness models by
      // mounting a new component instead.
      const runSlot = `effect${index}`;
      index += 1;
      if ((ranEffects[runSlot] ??= false)) return;
      ranEffects[runSlot] = true;
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };

  let render = () => {
    throw new Error('makeInteractiveReact: mount() installs the render function');
  };

  return {
    react,
    /**
     * Render one component as a mounted instance.
     * @param Component - the component under test.
     * @param props - its props.
     * @returns a getter for the latest element tree, its render count, and unmount.
     */
    mount(Component, props) {
      states = [];
      ranEffects = [];
      cleanups = [];
      renderCount = 0;
      rendered = undefined;
      render = () => {
        rendering = true;
        index = 0;
        renderCount += 1;
        try {
          rendered = Component(props);
        } finally {
          rendering = false;
        }
        return rendered;
      };
      render();
      return {
        live: () => rendered,
        renders: () => renderCount,
        unmount() {
          for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
          cleanups = [];
        },
      };
    },
  };
}

/** A `fetch` stand-in that records its calls and answers however the test says. */
function makeFetch(answer) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      return answer;
    },
  };
}

/** Flush pending microtasks so an awaited effect settles before asserting. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Render the media body in the interactive harness.
 * @param options - address, fetch answer, and locale.
 * @returns the live element getter, the unmount hook, and the recorded fetches.
 */
function renderBody({ resourceAddress, answer, t = (key, params) => (params === undefined ? `«${key}»` : `«${key}:${JSON.stringify(params)}»`) }) {
  const harness = makeInteractiveReact();
  const fetchStub = makeFetch(answer);
  const factory = new Function(
    'React',
    'h',
    'PLUGIN_ID',
    'NS',
    'fetch',
    'console',
    `${region}\nreturn { MediaBody };`,
  );
  const { MediaBody } = factory(harness.react, harness.react.createElement, 'dsh-plugin-sidebar-tabs', 'sidebarTabs', fetchStub.fetch, { info: () => {}, warn: () => {} });
  const mounted = harness.mount(MediaBody, {
    content: { kind: 'bytes', data: new Uint8Array(0) },
    resourceAddress,
    t,
  });
  return { live: mounted.live, renders: mounted.renders, unmount: mounted.unmount, calls: fetchStub.calls };
}

/** Collect every element of one type from a rendered tree. */
function elementsOfType(node, type) {
  if (node == null || typeof node !== 'object') return [];
  const own = node.type === type ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap((child) => elementsOfType(child, type))];
}

test('the media renderer registers through the public document-preview registry', () => {
  const definition = media.mediaDefinition(() => 'Video');
  assert.equal(definition.id, 'dsh-plugin-sidebar-tabs/media');
  // The extension band is what takes these suffixes away from the plain-text fallback.
  assert.equal(definition.priority, 'extension');
  assert.equal(definition.loading, 'bytes-complete');
  assert.equal(definition.wrap, false);
  assert.equal(definition.title(), 'Video');
});

test('every advertised suffix has a media type', () => {
  for (const suffix of media.MEDIA_SUFFIXES) {
    assert.notEqual(media.mediaTypeOf(`clip.${suffix}`), undefined, `${suffix} must resolve`);
  }
  for (const [suffix, type] of media.MEDIA_TYPES) {
    assert.ok(media.MEDIA_SUFFIXES.includes(suffix), `${suffix} must be advertised`);
    assert.match(type, /^(?:video|audio)\//u);
  }
});

test('suffix classification is case-insensitive and path-aware', () => {
  assert.equal(media.mediaTypeOf('/tmp/电影/第 1 集.MP4'), 'video/mp4');
  assert.equal(media.mediaTypeOf('C:\\media\\CLIP.MOV'), 'video/quicktime');
  assert.equal(media.mediaTypeOf('song.M4A'), 'audio/mp4');
  assert.equal(media.mediaTypeOf('/deep/path.mp4?token=x'), undefined, 'a query string is not part of the name');
  assert.equal(media.mediaTypeOf('notes.md'), undefined);
  assert.equal(media.mediaTypeOf('.mp4'), undefined);
  assert.equal(media.mediaTypeOf('mp4'), undefined);
});

test('a session file address yields the Session and path the Host must authorize', () => {
  assert.deepEqual(media.parseFileAddress('dsh-resource://file/session/s1/tmp/clip.mp4'), {
    sessionId: 's1',
    path: 'tmp/clip.mp4',
  });
  // An absolute path keeps its leading slash, because the address grammar does.
  assert.deepEqual(media.parseFileAddress('dsh-resource://file/session/s1//Users/me/clip.mp4'), {
    sessionId: 's1',
    path: '/Users/me/clip.mp4',
  });
  assert.deepEqual(media.parseFileAddress('dsh-resource://file/session/session-4a%2Fb/a%20b/c.mp4'), {
    sessionId: 'session-4a/b',
    path: 'a b/c.mp4',
  });
  assert.deepEqual(media.parseFileAddress('dsh-resource://file/session/s1/%E7%94%B5%E5%BD%B1.mp4'), {
    sessionId: 's1',
    path: '电影.mp4',
  });
});

test('addresses the Host cannot authorize are refused instead of guessed at', () => {
  for (const address of [
    undefined,
    null,
    42,
    '',
    'sidebar://guide',
    'dsh-resource://file/absolute/tmp/clip.mp4',
    'dsh-resource://file/session/',
    'dsh-resource://file/session/s1',
    'dsh-resource://file/session/s1/',
    'dsh-resource://file/session/s1/%E0%A4%A',
  ]) {
    assert.equal(media.parseFileAddress(address), undefined, `expected ${String(address)} to be refused`);
  }
});

test('a query or fragment never reaches the authorized path', () => {
  assert.equal(media.parseFileAddress('dsh-resource://file/session/s1/a.mp4?line=12').path, 'a.mp4');
  assert.equal(media.parseFileAddress('dsh-resource://file/session/s1/a.mp4#t=30').path, 'a.mp4');
});

test('the tab label is the file name, not the path', () => {
  assert.equal(media.baseNameOf('a/b/c.mp4'), 'c.mp4');
  assert.equal(media.baseNameOf('c.mp4'), 'c.mp4');
  assert.equal(media.baseNameOf('/'), '');
});

test('a body without a usable address reports itself unsupported', () => {
  const rendered = media.MediaBody({
    content: { kind: 'bytes', data: new Uint8Array(0) },
    resourceAddress: 'dsh-resource://file/absolute/tmp/clip.mp4',
    t: (key) => `«${key}»`,
  });
  const flat = JSON.stringify(rendered);
  assert.match(flat, /media\.unsupported/u);
});

test('a known suffix renders a player element rather than a byte window', () => {
  const rendered = media.MediaBody({
    content: { kind: 'bytes', data: new Uint8Array(0) },
    resourceAddress: 'dsh-resource://file/session/s1/media/clip.mp4',
    t: (key) => `«${key}»`,
  });
  const flat = JSON.stringify(rendered);
  // The seat's prepared bytes are deliberately not rendered, and the status line
  // starts in the loading state until the Host answers with a signed URL.
  assert.match(flat, /media\.opening/u);
  assert.match(flat, /"data-media-state":"loading"/u);
});

test('an audio suffix takes the audio branch', () => {
  const rendered = media.MediaBody({
    content: { kind: 'bytes', data: new Uint8Array(0) },
    resourceAddress: 'dsh-resource://file/session/s1/media/song.mp3',
    t: (key) => `«${key}»`,
  });
  assert.match(JSON.stringify(rendered), /dsh-st-mediaAudio/u);
});

test('the body asks the Host for a signed URL for the address it was given', async () => {
  const body = renderBody({
    resourceAddress: 'dsh-resource://file/session/s1/media/clip.mp4',
    answer: { ok: true, json: async () => ({ url: '/api/sidebar-tabs/media/stream?token=signed', mediaType: 'video/mp4', bytes: 10 }) },
  });
  await settle();

  assert.equal(body.calls.length, 1);
  assert.equal(body.calls[0].url, '/api/sidebar-tabs/media/sign');
  assert.equal(body.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(body.calls[0].init.body), { sessionId: 's1', path: 'media/clip.mp4' });

  const [player] = elementsOfType(body.live(), 'video');
  assert.ok(player, 'a ready media body must render a video element');
  assert.equal(player.props.src, '/api/sidebar-tabs/media/stream?token=signed');
  assert.equal(player.props.controls, true);
  assert.equal(player.props.preload, 'metadata');
  assert.match(JSON.stringify(body.live()), /"data-media-state":"ready"/u);
  body.unmount();
});

test('an audio file renders an audio element, not a video one', async () => {
  const body = renderBody({
    resourceAddress: 'dsh-resource://file/session/s1/media/song.mp3',
    answer: { ok: true, json: async () => ({ url: '/stream?token=x' }) },
  });
  await settle();
  const [audio] = elementsOfType(body.live(), 'audio');
  assert.ok(audio, 'audio suffixes must not be handed to a video element');
  assert.equal(elementsOfType(body.live(), 'video').length, 0);
  body.unmount();
});

test('a refused sign request surfaces the Host code instead of a blank player', async () => {
  const body = renderBody({
    resourceAddress: 'dsh-resource://file/session/s1/media/gone.mp4',
    answer: { ok: false, status: 404, json: async () => ({ error: 'unreadable', detail: 'workspace-file/not-found' }) },
  });
  await settle();
  const flat = JSON.stringify(body.live());
  assert.match(flat, /"data-media-state":"failed"/u);
  assert.match(flat, /workspace-file\/not-found/u);
  assert.equal(elementsOfType(body.live(), 'video').length, 0);
  body.unmount();
});

test('a transport failure is reported rather than left loading forever', async () => {
  const body = renderBody({
    resourceAddress: 'dsh-resource://file/session/s1/media/clip.mp4',
    answer: { ok: false, status: 500, json: async () => { throw new Error('not json'); } },
  });
  await settle();
  assert.match(JSON.stringify(body.live()), /"data-media-state":"failed"/u);
  body.unmount();
});

test('unmounting aborts the pending sign request', async () => {
  const body = renderBody({
    resourceAddress: 'dsh-resource://file/session/s1/media/clip.mp4',
    answer: { ok: true, json: async () => ({ url: '/x' }) },
  });
  const signal = body.calls[0].init.signal;
  assert.equal(signal.aborted, false);
  body.unmount();
  assert.equal(signal.aborted, true, 'a closed tab must not leave its request in flight');
});
