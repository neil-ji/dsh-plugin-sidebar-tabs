/**
 * Smoke test for the built client bundle.
 *
 * It loads `lib/client.js` the way the browser does — through
 * `window.__ModuleLoader__.load` — with `react` and the primitives package
 * stubbed, then drives `apply()` against a fake client context. That exercises
 * the real registration shapes, the reopen ledger's diff, the batch-close
 * arithmetic and the shortcut ladder before anything is installed into a
 * profile.
 *
 *   node --test tests/
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8');

/** A React stand-in: elements are plain data, hooks are inert. */
function makeReact() {
  const element = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });
  return {
    createElement: element,
    Fragment: Symbol('Fragment'),
    useMemo: (fn) => fn(),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (subscribe, getSnapshot) => {
      void subscribe;
      return getSnapshot();
    },
  };
}

/** Every component the plugin may destructure, as taggable stubs. */
function makePrimitives() {
  const icon = (name) => function Icon() {
    return { type: `icon:${name}` };
  };
  return {
    MenuItemButton: function MenuItemButton() {},
    Button: function Button() {},
    Tooltip: function Tooltip() {},
    writeClipboard: async () => true,
    IconCloseOutlineRegular: icon('close'),
    IconChevronLeftOutlineRegular: icon('chevron-left'),
    IconChevronRightOutlineRegular: icon('chevron-right'),
    IconCopyOutlineRegular: icon('copy'),
    IconRefreshOutlineRegular: icon('refresh'),
    IconTrashOutlineRegular: icon('trash'),
    IconFolderOpenOutlineRegular: icon('folder'),
    IconCodeOutlineRegular: icon('code'),
    IconBrowseOutlineRegular: icon('browse'),
    IconQueueOutlineRegular: icon('queue'),
    IconWarningOutlineRegular: icon('warning'),
    IconPanelLeftOutlineRegular: icon('panel'),
  };
}

/**
 * A pane element stand-in matching the `data-dockkit-*` contract the plugin
 * reads: a container per pane, and chips inside it in render order.
 */
function makePane(paneId, tabIds, { float = false } = {}) {
  const chips = tabIds.map((tabId) => ({ dataset: { dockkitTab: tabId } }));
  return {
    dataset: float ? { dockkitFloat: paneId } : { dockkitPane: paneId },
    querySelectorAll: (selector) => (selector === '[data-dockkit-tab]' ? chips : []),
  };
}

/**
 * Load the bundle once and hand back the plugin object it exports.
 * @param panes - pane stand-ins the fake document should report.
 */
function loadPlugin(panes = []) {
  const document = {
    // Pretend our stylesheet tag is already published.
    querySelector: () => ({}),
    querySelectorAll: (selector) => {
      if (selector === '[data-dockkit-pane],[data-dockkit-float]') return panes;
      if (selector === '[data-dockkit-tab]') return panes.flatMap((pane) => pane.querySelectorAll('[data-dockkit-tab]'));
      return [];
    },
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  };
  globalThis.document = document;

  let plugin;
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        assert.equal(id, 'dsh-plugin-sidebar-tabs', 'loader id must be the package name');
        plugin = factory((specifier) => {
          if (specifier === 'react') return makeReact();
          if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return makePrimitives();
          throw new Error(`unexpected require(${specifier})`);
        });
      },
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', bundle)(globalThis.window);
  assert.ok(plugin, 'the bundle must register a module');
  return plugin;
}

/**
 * A fake client context recording every registration the plugin makes, with a
 * controllable tab inventory.
 *
 * Pane layout is NOT a parameter here: the plugin reads panes from the document,
 * which `loadPlugin(panes)` owns. Keeping the two apart is what makes it obvious
 * that a pane-dependent test must load the bundle against those panes.
 */
function makeContext({ sessionId = 's1', tabs = [], target } = {}) {
  const record = {
    effects: [],
    locale: [],
    slots: [],
    types: [],
    shortcuts: [],
    previews: [],
    injections: [],
    closed: [],
    focused: [],
    opened: [],
    floated: [],
    docked: [],
    collapsed: 0,
  };
  const listeners = new Set();
  let inventory = tabs.map((tab) => ({ sessionId, tabId: tab.id, kind: tab.kind, contentId: tab.contentId }));
  const records = new Map([[sessionId, tabs]]);

  const openTabs = {
    getSnapshot: () => inventory,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const sidebar = {
    openTabs,
    mounted: { getSnapshot: () => sessionId, subscribe: () => () => {} },
    tabsIn: (id) => records.get(id) ?? [],
    close: (tabId) => {
      record.closed.push(tabId);
      const live = records.get(sessionId) ?? [];
      records.set(sessionId, live.filter((row) => row.id !== tabId));
      inventory = inventory.filter((row) => row.tabId !== tabId);
      for (const listener of listeners) listener();
    },
    focus: (tabId) => record.focused.push(tabId),
    openResource: (address) => record.opened.push(address),
    openTab: (kind) => record.opened.push(kind),
    float: (tabId, rect) => record.floated.push({ tabId, rect }),
    dock: (paneId) => record.docked.push(paneId),
    toggleExpanded: () => {
      record.collapsed += 1;
    },
    focusedTarget: () => target,
    isTargetCurrent: () => true,
  };

  const ctx = {
    /**
     * Mirror Cordis's `_execute` return-value contract exactly.
     *
     * `@deepseek-ai/cordis` accepts a disposer function, null/undefined, a
     * thenable, or an iterator — and throws `TypeError("Invalid effect")` for
     * anything else. A plain object returned by accident therefore aborts the
     * whole `apply`, which is a silent zero-registration failure in the
     * browser, so the fake refuses it the same way.
     */
    effect(fn) {
      const effect = fn();
      if (typeof effect === 'function') {
        record.effects.push(effect);
        return undefined;
      }
      if (effect === null || effect === undefined) return undefined;
      if (typeof effect !== 'object' && typeof effect !== 'function') throw new TypeError('Invalid effect');
      if ('then' in effect) throw new TypeError('Invalid effect (async effects are not modelled here)');
      if (Symbol.iterator in effect || Symbol.asyncIterator in effect) return undefined;
      throw new TypeError('Invalid effect');
    },
    locale: {
      register: (ns, dicts) => {
        record.locale.push({ ns, dicts });
        return () => {};
      },
      bind: () => (key) => `«${key}»`,
    },
    slots: {
      inject: (name, fn) => {
        fn();
        return () => {};
      },
      register: (definition, Component) => {
        record.slots.push({ definition, Component });
        return () => {};
      },
    },
    shortcuts: {
      register: (command) => {
        record.shortcuts.push(command);
        return () => {};
      },
    },
    sidebarRight: sidebar,
    sidebarRightTabs: {
      register: (definition) => {
        record.types.push(definition);
        return () => {};
      },
    },
    /**
     * Mirror Cordis's `ctx.inject(deps, callback)`: run the callback now, in a
     * child context, and record the dependency names it parked on. The real
     * implementation re-runs the callback whenever a dependency changes and
     * disposes its effects in between, so returning a disposer here is what
     * makes a test able to model an unload.
     */
    inject(deps, callback) {
      record.injections.push({ deps, callback });
      return callback(ctx);
    },
    documentPreviews: {
      register: (definition) => {
        record.previews.push(definition);
        return () => {};
      },
    },
  };

  return { ctx, record, sidebar, openTabs, records, sessionId };
}

const tab = (id, kind, contentId, title) => ({ id, kind, contentId, title });

/** Flatten the element tree produced by the stubbed `createElement`. */
function flatten(node) {
  if (node == null || typeof node !== 'object') return [];
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

test('the bundle loads and the plugin declares its services', () => {
  const plugin = loadPlugin();
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'shortcuts', 'sidebarRight', 'sidebarRightTabs']);
});

test('apply registers the menu seat, the tab type, its body and the copy namespace', () => {
  const plugin = loadPlugin();
  const { ctx, record } = makeContext({ tabs: [tab('tab1', 'guide', 'sidebar://guide', 'Guide')] });
  plugin.apply(ctx);

  const menu = record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.menu.item');
  assert.ok(menu, 'the per-tab menu seat must be occupied');
  assert.equal(menu.definition.id, 'dsh-plugin-sidebar-tabs/menu');
  assert.equal(menu.definition.order, 10);

  const body = record.slots.find((entry) => entry.definition.name === 'sidebar.right.pane.tab');
  assert.ok(body, 'the manager body seat must be occupied');
  // A keyed seat is dispatched by the type definition's *id*, not its kind.
  assert.equal(body.definition.key, 'dsh-plugin-sidebar-tabs/manager');

  assert.equal(record.types.length, 1);
  const type = record.types[0];
  assert.equal(type.id, 'dsh-plugin-sidebar-tabs/manager');
  assert.equal(type.kind, 'sidebar-tabs.manager');
  assert.equal(type.priority, 'extension');
  assert.equal(typeof type.title, 'function');
  assert.equal(type.guide.length, 1);
  assert.equal(type.guide[0].id, 'manager');

  assert.equal(record.locale.length, 1);
  assert.equal(record.locale[0].ns, 'sidebarTabs');
  assert.ok(record.locale[0].dicts.zh['menu.closeOthers']);
  assert.ok(record.locale[0].dicts.en['menu.closeOthers']);
});

test('the media renderer registers a document preview and its keyed body', () => {
  const plugin = loadPlugin();
  const { ctx, record } = makeContext();
  plugin.apply(ctx);

  // It parks on the shipped document preview rather than assuming it.
  const parked = record.injections.find((entry) => Array.isArray(entry.deps) && entry.deps.includes('documentPreviews'));
  assert.ok(parked, 'the media half must wait for ctx.documentPreviews');

  assert.equal(record.previews.length, 1);
  const preview = record.previews[0];
  assert.equal(preview.id, 'dsh-plugin-sidebar-tabs/media');
  assert.equal(preview.priority, 'extension');
  assert.equal(preview.loading, 'renderer');
  assert.ok(preview.extensions.includes('mp4'));
  assert.ok(preview.extensions.includes('mp3'));

  const body = record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.document');
  assert.ok(body, 'the media body seat must be occupied');
  assert.equal(body.definition.key, 'dsh-plugin-sidebar-tabs/media');
  assert.equal(typeof body.Component, 'function');
});

test('every namespaced literal in the client source is a real copy key', () => {
  const plugin = loadPlugin();
  const { ctx, record } = makeContext();
  plugin.apply(ctx);
  const source = fs.readFileSync(path.join(root, 'src/client.js'), 'utf8');
  // The `t('…')` scan above misses keys chosen by a ternary, so this asserts the
  // weaker but wider property: a literal shaped like a copy key must be one.
  // Command ids are dotted too (`sidebarTabs.closeOthers`), hence the allow list.
  const COPY_NAMESPACES = ['menu', 'manager', 'command', 'media'];
  const candidates = new Set(
    [...source.matchAll(/'([a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z0-9]*)'/g)]
      .map((match) => match[1])
      .filter((key) => COPY_NAMESPACES.includes(key.slice(0, key.indexOf('.')))),
  );
  assert.ok(candidates.size > 20, 'the scan must find the plugin’s copy keys at all');
  for (const dict of [record.locale[0].dicts.zh, record.locale[0].dicts.en]) {
    const missing = [...candidates].filter((key) => !(key in dict));
    assert.deepEqual(missing, [], `missing copy keys: ${missing.join(', ')}`);
  }
});

test('the copy namespace covers exactly the keys the plugin renders', () => {
  const plugin = loadPlugin();
  const { ctx, record } = makeContext();
  plugin.apply(ctx);
  const dict = record.locale[0].dicts.zh;
  // Every key produced by a `t('…')` call in the source must exist in the dict.
  const source = fs.readFileSync(path.join(root, 'src/client.js'), 'utf8');
  const used = new Set([...source.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]));
  const missing = [...used].filter((key) => !(key in dict));
  assert.deepEqual(missing, [], `missing zh keys: ${missing.join(', ')}`);
  const en = record.locale[0].dicts.en;
  const missingEn = [...used].filter((key) => !(key in en));
  assert.deepEqual(missingEn, [], `missing en keys: ${missingEn.join(', ')}`);
});

test('the menu offers batch closes, and left/right follow pane order', () => {
  const panes = [makePane('pane1', ['tab1', 'tab2', 'tab3'])];
  const plugin = loadPlugin(panes);
  const tabs = [
    tab('tab1', 'guide', 'sidebar://guide', 'Guide'),
    tab('tab2', 'document', 'dsh-resource://file/a.md', 'a.md'),
    tab('tab3', 'document', 'dsh-resource://file/b.md', 'b.md'),
  ];
  const { ctx, record } = makeContext({ tabs, panes });
  plugin.apply(ctx);

  const { Component } = record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.menu.item');

  // Tab 2 of 3: one tab to the left, one to the right, one other.
  const rendered = Component({ tab: tabs[1], dismiss: () => {} });
  const rows = flatten(rendered).filter((node) => typeof node.type === 'function' && node.type.name === 'MenuItemButton');
  assert.equal(rows.length, 7, 'closeOthers + left + right + float + copy + reopen + closeAll');

  const byLabel = new Map(rows.map((row) => [row.children[0], row.props]));
  assert.equal(byLabel.get('«menu.closeOthers»').disabled, false);
  assert.equal(byLabel.get('«menu.closeLeft»').disabled, false);
  assert.equal(byLabel.get('«menu.closeRight»').disabled, false);
  assert.equal(byLabel.get('«menu.closeAll»').danger, true);
  assert.equal(byLabel.get('«menu.closeOthers»').separatorBefore, true);
  // Nothing has closed yet, so reopening has nothing to offer.
  assert.equal(byLabel.get('«menu.reopen»').disabled, true);

  byLabel.get('«menu.closeRight»').onSelect();
  assert.deepEqual(record.closed, ['tab3'], 'close-right must close only the tabs after it');

  record.closed.length = 0;
  byLabel.get('«menu.closeLeft»').onSelect();
  assert.deepEqual(record.closed, ['tab1']);
});

test('menu rows carry no icons, matching the kit’s own rows', () => {
  const panes = [makePane('pane1', ['tab1', 'tab2'])];
  const plugin = loadPlugin(panes);
  const tabs = [
    tab('tab1', 'guide', 'sidebar://guide', 'Guide'),
    tab('tab2', 'document', 'dsh-resource://file/a.md', 'a.md'),
  ];
  const { ctx, record } = makeContext({ tabs, panes });
  plugin.apply(ctx);
  const { Component } = record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.menu.item');

  for (const contextTab of [tabs[0], tabs[1]]) {
    const rows = flatten(Component({ tab: contextTab, dismiss: () => {} })).filter(
      (node) => typeof node.type === 'function' && node.type.name === 'MenuItemButton',
    );
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.props.icon, undefined, `${row.children[0]} must not carry an icon`);
      // Only the declared option keys, so nothing leaks an unexpected prop.
      assert.deepEqual(
        Object.keys(row.props).filter((key) => !['key', 'separatorBefore', 'disabled', 'danger', 'onSelect'].includes(key)),
        [],
      );
    }
  }
});

test('a docked tab offers float, a floating tab offers dock', () => {
  const dockedPanes = [makePane('pane1', ['tab1', 'tab2'])];
  const plugin = loadPlugin(dockedPanes);
  const tabs = [
    tab('tab1', 'guide', 'sidebar://guide', 'Guide'),
    tab('tab2', 'document', 'dsh-resource://file/a.md', 'a.md'),
  ];
  const docked = makeContext({ tabs, panes: dockedPanes });
  plugin.apply(docked.ctx);
  const menu = docked.record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.menu.item').Component;
  const dockedRows = new Map(
    flatten(menu({ tab: tabs[1], dismiss: () => {} }))
      .filter((node) => typeof node.type === 'function' && node.type.name === 'MenuItemButton')
      .map((row) => [row.children[0], row.props]),
  );
  assert.ok(dockedRows.has('«menu.float»'), 'a docked tab must offer floating');
  assert.ok(!dockedRows.has('«menu.unfloat»'));
  dockedRows.get('«menu.float»').onSelect();
  // No rect: the kit cascades the panel from the last one.
  assert.deepEqual(docked.record.floated, [{ tabId: 'tab2', rect: undefined }]);

  // Same tab, now in a floating pane: the pair inverts and dock takes the pane
  // id. The pane layout comes from the loaded fake document, so the bundle has
  // to be loaded against the floating panes.
  const floatPanes = [makePane('float1', ['tab1', 'tab2'], { float: true })];
  const floatPlugin = loadPlugin(floatPanes);
  const floating = makeContext({ tabs });
  floatPlugin.apply(floating.ctx);
  const floatMenu = floating.record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.menu.item').Component;
  const floatRows = new Map(
    flatten(floatMenu({ tab: tabs[1], dismiss: () => {} }))
      .filter((node) => typeof node.type === 'function' && node.type.name === 'MenuItemButton')
      .map((row) => [row.children[0], row.props]),
  );
  assert.ok(floatRows.has('«menu.unfloat»'), 'a floating tab must offer docking back');
  assert.ok(!floatRows.has('«menu.float»'));
  floatRows.get('«menu.unfloat»').onSelect();
  assert.deepEqual(floating.record.docked, ['float1'], 'dock takes the floating pane id, not the tab id');
});

test('the manager lists a float pane with a dock action and no decorative glyphs', () => {
  const panes = [makePane('pane1', ['tab1']), makePane('float1', ['tab2'], { float: true })];
  const plugin = loadPlugin(panes);
  const tabs = [
    tab('tab1', 'guide', 'sidebar://guide', 'Guide'),
    tab('tab2', 'document', 'dsh-resource://file/a.md', 'a.md'),
  ];
  const { ctx, record } = makeContext({ tabs, panes, sessionId: 's1' });
  plugin.apply(ctx);
  const { Component } = record.slots.find((entry) => entry.definition.name === 'sidebar.right.pane.tab');
  // The manager body reads hooks; the fake React resolves them synchronously.
  const tree = Component({});
  const buttons = flatten(tree).filter((node) => typeof node.type === 'function' && node.type.name === 'Button');
  const labels = buttons.map((node) => node.children[0]).filter((child) => typeof child === 'string');
  assert.ok(labels.includes('«manager.undock»'), 'a float pane gets a dock control');
  assert.ok(labels.includes('«manager.closePane»'));
  assert.equal(buttons.filter((node) => node.children[0] === '«manager.undock»').length, 1, 'only the float pane offers dock');

  const dockButton = buttons.find((node) => node.children[0] === '«manager.undock»');
  dockButton.props.onClick();
  assert.deepEqual(record.docked, ['float1']);

  // Icons survive only inside controls that act. `props.icon` IS the control's
  // icon slot, so any icon element rendered bare in the tree is decoration.
  assert.ok(
    buttons.some((node) => node.children[0] === '«manager.closeAll»' && node.props.icon != null),
    'an acting control still carries its icon',
  );
  assert.deepEqual(
    flatten(tree).filter((node) => typeof node.type === 'function' && String(node.type.name).startsWith('Icon')),
    [],
    'no decorative icon may be rendered outside a control',
  );
});

test('a tab the DOM cannot place keeps the safe rows and drops left/right', () => {
  const plugin = loadPlugin([makePane('pane1', ['tab1'])]);
  const tabs = [tab('tab1', 'guide', 'sidebar://guide', 'Guide'), tab('tab9', 'document', 'dsh-resource://file/x.md', 'x.md')];
  const { ctx, record } = makeContext({ tabs, panes: [makePane('pane1', ['tab1'])] });
  plugin.apply(ctx);

  const { Component } = record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.menu.item');
  const rows = flatten(Component({ tab: tabs[1], dismiss: () => {} })).filter(
    (node) => typeof node.type === 'function' && node.type.name === 'MenuItemButton',
  );
  const labels = rows.map((row) => row.children[0]);
  assert.ok(labels.includes('«menu.closeOthers»'));
  assert.ok(!labels.includes('«menu.closeLeft»'), 'left has no meaning outside a pane');
  assert.ok(!labels.includes('«menu.closeRight»'));
  // Without a pane we cannot tell docked from floating, so neither row is offered.
  assert.ok(!labels.includes('«menu.float»'));
  assert.ok(!labels.includes('«menu.unfloat»'));
});

test('the ledger remembers a close and reopens it at its recorded address', () => {
  const plugin = loadPlugin();
  const tabs = [
    tab('tab1', 'guide', 'sidebar://guide', 'Guide'),
    tab('tab2', 'document', 'dsh-resource://file/a.md', 'a.md'),
  ];
  const { ctx, record, sidebar } = makeContext({ tabs });
  plugin.apply(ctx);

  const { Component } = record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.menu.item');
  const rowsFor = (contextTab) =>
    new Map(
      flatten(Component({ tab: contextTab, dismiss: () => {} }))
        .filter((node) => typeof node.type === 'function' && node.type.name === 'MenuItemButton')
        .map((row) => [row.children[0], row.props]),
    );

  // Nothing has closed yet.
  assert.equal(rowsFor(tabs[0]).get('«menu.reopen»').disabled, true);

  // Close tab2 *without* going through the plugin, the way Cmd+W would: the
  // inventory republishes and the ledger's diff is what notices.
  sidebar.close('tab2');

  const rows = rowsFor(tabs[0]);
  assert.equal(rows.get('«menu.reopen»').disabled, false, 'a close made elsewhere must still be reopenable');
  rows.get('«menu.reopen»').onSelect();
  assert.deepEqual(record.opened, ['dsh-resource://file/a.md'], 'a resource tab reopens by its address');

  // Reopening empties the stack again.
  assert.equal(rowsFor(tabs[0]).get('«menu.reopen»').disabled, true);
});

test('a closed page tab reopens by kind, not by address', () => {
  const plugin = loadPlugin();
  const tabs = [tab('tab1', 'guide', 'sidebar://guide', 'Guide'), tab('tab2', 'sidebar-tabs.manager', 'sidebar://sidebar-tabs.manager', 'Manager')];
  const { ctx, record, sidebar } = makeContext({ tabs });
  plugin.apply(ctx);
  const { Component } = record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.menu.item');
  const rows = new Map(
    flatten(Component({ tab: tabs[0], dismiss: () => {} }))
      .filter((node) => typeof node.type === 'function' && node.type.name === 'MenuItemButton')
      .map((row) => [row.children[0], row.props]),
  );
  sidebar.close('tab2');
  rows.get('«menu.reopen»').onSelect();
  assert.deepEqual(record.opened, ['sidebar-tabs.manager']);
});

test('close-all closes the context tab last so the column collapses once', () => {
  const panes = [makePane('pane1', ['tab1', 'tab2', 'tab3'])];
  const plugin = loadPlugin(panes);
  const tabs = [
    tab('tab1', 'document', 'dsh-resource://file/a.md', 'a.md'),
    tab('tab2', 'document', 'dsh-resource://file/b.md', 'b.md'),
    tab('tab3', 'document', 'dsh-resource://file/c.md', 'c.md'),
  ];
  const { ctx, record } = makeContext({ tabs, panes });
  plugin.apply(ctx);
  const { Component } = record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.menu.item');
  const rows = flatten(Component({ tab: tabs[0], dismiss: () => {} })).filter(
    (node) => typeof node.type === 'function' && node.type.name === 'MenuItemButton',
  );
  const all = rows.find((row) => row.children[0] === '«menu.closeAll»');
  all.props.onSelect();
  assert.equal(record.closed[record.closed.length - 1], 'tab1', 'the context tab must go last');
  assert.deepEqual([...record.closed].sort(), ['tab1', 'tab2', 'tab3']);
});

test('every shortcut registers, resolves against focus, and runs', () => {
  const panes = [makePane('pane1', ['tab1', 'tab2'])];
  const plugin = loadPlugin(panes);
  const tabs = [
    tab('tab1', 'guide', 'sidebar://guide', 'Guide'),
    tab('tab2', 'document', 'dsh-resource://file/a.md', 'a.md'),
  ];
  const target = { sessionId: 's1', paneId: 'pane1', host: 'dock', tabId: 'tab1' };
  const { ctx, record } = makeContext({ tabs, panes, target });
  plugin.apply(ctx);

  const ids = record.shortcuts.map((command) => command.id).sort();
  assert.deepEqual(ids, ['sidebarTabs.closeAll', 'sidebarTabs.closeOthers', 'sidebarTabs.manager', 'sidebarTabs.reopen']);

  const byId = new Map(record.shortcuts.map((command) => [command.id, command]));
  // Defaults cover all six runtime:platform configurations or the registry rejects them.
  for (const command of record.shortcuts) {
    assert.equal(Object.keys(command.defaults).length, 6, `${command.id} must declare all six configurations`);
  }

  const closeOthers = byId.get('sidebarTabs.closeOthers');
  const decision = closeOthers.resolve({ target: null, source: 'page', modal: null });
  assert.equal(decision.status, 'handled');
  decision.run();
  assert.deepEqual(record.closed, ['tab2'], 'close-others must spare the focused tab');

  // Without focus inside the column the command refuses instead of acting blind.
  const blind = makeContext({ tabs, panes, target: undefined });
  plugin.apply(blind.ctx);
  const blindClose = blind.record.shortcuts.find((command) => command.id === 'sidebarTabs.closeOthers');
  assert.equal(blindClose.resolve({ target: null }).status, 'blocked');
  assert.deepEqual(blind.record.closed, []);

  // The manager command opens the page type by kind.
  const manager = byId.get('sidebarTabs.manager');
  manager.resolve({ target: null }).run();
  assert.deepEqual(record.opened, ['sidebar-tabs.manager']);
});

test('a rejected default binding degrades instead of losing the command', () => {
  const plugin = loadPlugin();
  const { ctx, record } = makeContext({ tabs: [tab('tab1', 'guide', 'sidebar://guide', 'Guide')] });
  const attempts = [];
  const realRegister = ctx.shortcuts.register;
  ctx.shortcuts.register = (command) => {
    attempts.push(Object.keys(command.defaults).length);
    // Refuse anything with a web binding, to force the desktop-only retry.
    if (Object.keys(command.defaults).some((config) => config.startsWith('web:'))) {
      throw new Error('Conflicting shortcut defaults');
    }
    return realRegister(command);
  };
  plugin.apply(ctx);

  assert.ok(attempts.includes(6), 'the full set is tried first');
  assert.ok(attempts.includes(3), 'then a desktop-only set');
  assert.equal(record.shortcuts.length, 4, 'every command still lands');
  for (const command of record.shortcuts) {
    assert.equal(Object.keys(command.defaults).length, 3, 'surviving commands keep their desktop bindings');
  }
});

test('the fake document fallback still orders tabs when chips sit outside panes', () => {
  // No pane containers at all: only chips in document order.
  const chips = ['tab1', 'tab2', 'tab3'].map((tabId) => ({ dataset: { dockkitTab: tabId } }));
  const plugin = loadPlugin();
  globalThis.document.querySelectorAll = (selector) =>
    selector === '[data-dockkit-pane],[data-dockkit-float]' ? [] : selector === '[data-dockkit-tab]' ? chips : [];

  const tabs = [
    tab('tab1', 'document', 'dsh-resource://file/a.md', 'a.md'),
    tab('tab2', 'document', 'dsh-resource://file/b.md', 'b.md'),
    tab('tab3', 'document', 'dsh-resource://file/c.md', 'c.md'),
  ];
  const { ctx, record } = makeContext({ tabs });
  plugin.apply(ctx);
  const { Component } = record.slots.find((entry) => entry.definition.name === 'sidebar.right.tab.menu.item');
  const rows = flatten(Component({ tab: tabs[1], dismiss: () => {} })).filter(
    (node) => typeof node.type === 'function' && node.type.name === 'MenuItemButton',
  );
  const byLabel = new Map(rows.map((row) => [row.children[0], row.props]));
  assert.equal(byLabel.get('«menu.closeLeft»').disabled, false, 'document order must still define left/right');
  byLabel.get('«menu.closeLeft»').onSelect();
  assert.deepEqual(record.closed, ['tab1']);
});
