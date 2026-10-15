/**
 * Client (browser) half of dsh-plugin-sidebar-tabs.
 *
 * This file is a *fragment*, not a module: tools/build.mjs wraps it in
 *   window.__ModuleLoader__.load({ id, factory: function (require) { ... } })
 * and appends `return createPlugin();`. So it declares no imports and no
 * exports; `require` is the envelope's argument and every bare specifier it
 * asks for is listed in package.json's `dsh.client.inject`.
 *
 * What it contributes, all through documented extension seats:
 *
 *   1. `sidebar.right.tab.menu.item` — browser-style batch actions on the tab
 *      whose menu is open: close others / to the left / to the right / all,
 *      copy the tab's address, and reopen a closed tab.
 *   2. A page tab type (`sidebar-tabs.manager`, id `dsh-plugin-sidebar-tabs/manager`)
 *      with a guide entry — an overview listing every open tab per pane, plus
 *      the reopen stack.
 *   3. Four keyboard commands, registered through `ctx.shortcuts`.
 *   4. Media renderers for the shipped document preview: `ctx.documentPreviews`
 *      gets an `extension`-band implementation for video and audio suffixes,
 *      which outranks the plain-text fallback those files would otherwise land
 *      in, and its body registers into the keyed `sidebar.right.tab.document`
 *      seat. The bytes come from the Host half's signed streaming route, never
 *      from a complete-file read, because a movie does not fit in one.
 *
 * The menu seat is dispatched with exactly `{ tab, dismiss }` and no bound tab
 * reader, so everything else this plugin needs it reads from the client context
 * captured in a closure. The docking kit's live DOM is consulted for one thing
 * the public service deliberately does not expose — the order of tabs inside a
 * pane, which "close to the right" is defined by — using the same
 * `data-dockkit-*` attributes the shipped right-sidebar package itself reads.
 */

const React = require('react');
const PRIMITIVES = require('@deepseek-ai/dsh-client-ui-primitives');

const h = React.createElement;

/** Copy namespace for everything this plugin says in the UI. */
const NS = 'sidebarTabs';
/** Loader id; the client resolves this bundle by the package name. */
const PLUGIN_ID = 'dsh-plugin-sidebar-tabs';
/** Tab-type identity: unique among all registrations, and the keyed-seat key. */
const MANAGER_ID = 'dsh-plugin-sidebar-tabs/manager';
/** Page kind the manager opens by; its record address is `sidebar://<kind>`. */
const MANAGER_KIND = 'sidebar-tabs.manager';
/** How many closed tabs one session remembers before the oldest falls off. */
const CLOSED_LIMIT = 25;

//#region copy

const ZH = {
  'menu.closeOthers': '关闭其它标签',
  'menu.closeLeft': '关闭左侧标签',
  'menu.closeRight': '关闭右侧标签',
  'menu.float': '浮出为浮窗',
  'menu.unfloat': '收回到侧边栏',
  'menu.copyAddress': '复制标签地址',
  'menu.reopen': '重新打开已关闭的标签',
  'menu.closeAll': '关闭全部标签',

  'manager.title': '标签管理',
  'manager.guide.description': '总览并批量管理右侧栏标签',
  'manager.heading': '右侧栏标签',
  'manager.openSuffix': '个已打开',
  'manager.paneLabel': '格',
  'manager.paneDock': '停靠',
  'manager.paneFloat': '浮窗',
  'manager.ungrouped': '其它',
  'manager.closePane': '关闭本格',
  'manager.undock': '收回',
  'manager.closeAll': '全部关闭',
  'manager.collapse': '收起右栏',
  'manager.empty': '这个会话还没有打开任何标签。',
  'manager.closedHeading': '最近关闭',
  'manager.closedEmpty': '没有可重新打开的标签。',
  'manager.reopen': '重新打开',
  'manager.jump': '跳到该标签',
  'manager.closeOne': '关闭',

  'command.closeOthers': '关闭右侧栏的其它标签',
  'command.closeAll': '关闭右侧栏的全部标签',
  'command.reopen': '重新打开刚关闭的右侧栏标签',
  'command.manager': '打开右侧栏标签管理',
  'command.noFocus': '请先把焦点放到右侧栏的页面上',
  'command.noSession': '请先打开一个会话',
  'command.nothingToReopen': '没有可重新打开的标签',
  'command.unavailable': '当前无法执行',

  'media.video': '视频',
  'media.audio': '音频',
  'media.opening': '正在打开媒体…',
  'media.unsupported': '这个扩展名没有可用的媒体播放器。',
  'media.failed': '无法播放这个文件。',
  'media.audioLabel': '音频播放器：{name}',
  'media.videoLabel': '视频播放器：{name}',
};

const EN = {
  'menu.closeOthers': 'Close other tabs',
  'menu.closeLeft': 'Close tabs to the left',
  'menu.closeRight': 'Close tabs to the right',
  'menu.float': 'Float as a window',
  'menu.unfloat': 'Send back to the sidebar',
  'menu.copyAddress': 'Copy tab address',
  'menu.reopen': 'Reopen closed tab',
  'menu.closeAll': 'Close all tabs',

  'manager.title': 'Tab manager',
  'manager.guide.description': 'See and batch-manage right sidebar tabs',
  'manager.heading': 'Right sidebar tabs',
  'manager.openSuffix': 'open',
  'manager.paneLabel': 'Pane',
  'manager.paneDock': 'Docked',
  'manager.paneFloat': 'Floating',
  'manager.ungrouped': 'Other',
  'manager.closePane': 'Close pane',
  'manager.undock': 'Send back',
  'manager.closeAll': 'Close all',
  'manager.collapse': 'Collapse column',
  'manager.empty': 'This session has not opened any tabs yet.',
  'manager.closedHeading': 'Recently closed',
  'manager.closedEmpty': 'Nothing to reopen.',
  'manager.reopen': 'Reopen',
  'manager.jump': 'Focus this tab',
  'manager.closeOne': 'Close',

  'command.closeOthers': 'Close the right sidebar’s other tabs',
  'command.closeAll': 'Close all right sidebar tabs',
  'command.reopen': 'Reopen the last closed right sidebar tab',
  'command.manager': 'Open the right sidebar tab manager',
  'command.noFocus': 'Focus a right sidebar page first',
  'command.noSession': 'Open a session first',
  'command.nothingToReopen': 'Nothing to reopen',
  'command.unavailable': 'Not available right now',

  'media.video': 'Video',
  'media.audio': 'Audio',
  'media.opening': 'Opening media…',
  'media.unsupported': 'No media player is registered for this extension.',
  'media.failed': 'This file could not be played.',
  'media.audioLabel': 'Audio player: {name}',
  'media.videoLabel': 'Video player: {name}',
};

//#endregion

//#region style

const CSS = `
.dsh-st-page{display:flex;box-sizing:border-box;flex-direction:column;gap:14px;height:100%;overflow:auto;padding:16px 16px 32px;color:var(--dsw-alias-label-primary);font:inherit}
.dsh-st-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.dsh-st-heading{font-size:13px;font-weight:600}
.dsh-st-count{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-st-headActions{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.dsh-st-group{display:flex;flex-direction:column;gap:2px}
.dsh-st-groupHead{display:flex;align-items:center;gap:8px;padding:0 2px 4px;color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-st-groupAction{margin-left:auto}
.dsh-st-row{display:flex;box-sizing:border-box;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;font:inherit;text-align:left}
.dsh-st-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-st-rowLabel{flex:1;min-width:0;overflow:hidden;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;white-space:nowrap;text-overflow:ellipsis;cursor:pointer}
.dsh-st-rowAction{display:flex;flex:none;opacity:0}
.dsh-st-row:hover .dsh-st-rowAction,.dsh-st-row:focus-within .dsh-st-rowAction,.dsh-st-rowAction:focus-within{opacity:1}
.dsh-st-empty{padding:6px 8px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px}
.dsh-st-sep{height:1px;margin:8px 0;background:var(--dsw-alias-border-l1)}
.dsh-st-media{position:relative;display:flex;box-sizing:border-box;align-items:center;justify-content:center;width:100%;min-height:120px;padding:8px}
.dsh-st-mediaFrame{box-sizing:border-box;max-width:100%;margin:0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:#000}
.dsh-st-mediaStatus{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
.dsh-st-media[data-media-state="ready"] .dsh-st-mediaStatus{display:none}
.dsh-st-mediaAudio{display:flex;align-items:center;justify-content:center;width:100%;padding:16px}
.dsh-st-mediaAudio .dsh-st-mediaFrame{width:100%;background:transparent}
`;

/**
 * Publish this plugin's stylesheet once per document.
 *
 * The tag is keyed the way the shipped client packages key theirs, so a hot
 * reload of the bundle neither duplicates nor replaces anything.
 */
function installStyle() {
  if (typeof document === 'undefined') return;
  const tagId = `${PLUGIN_ID}/sidebar-tabs.css`;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = PLUGIN_ID;
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

//#endregion

//#region shared helpers

/** Run `fn`, swallowing failures: one broken tab must never break the whole menu. */
function attempt(what, fn) {
  try {
    return fn();
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] ${what} failed`, error);
    return undefined;
  }
}

/** A session's committed tab records; empty before that surface is adopted. */
function sessionTabs(sidebar, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return [];
  const rows = attempt('read tabs', () => sidebar.tabsIn(sessionId));
  return Array.isArray(rows) ? rows.filter((row) => row && typeof row.id === 'string') : [];
}

/** Best-effort readable name for a tab whose captured title is not known. */
function derivedTitle(row) {
  const address = typeof row.contentId === 'string' ? row.contentId : '';
  const tail = address.split('/').filter(Boolean).pop();
  const candidate = address.startsWith('sidebar://') || tail === undefined ? row.kind : tail;
  if (typeof candidate !== 'string' || candidate === '') return '';
  return attempt('decode address', () => decodeURIComponent(candidate)) ?? candidate;
}

/**
 * Read the live docking layout from the DOM, pane by pane, in render order.
 *
 * `ctx.sidebarRight` is an action surface with no layout snapshot, and the
 * docking kit is not a package a client plugin can require, so the tab strip's
 * own `data-dockkit-*` attributes are how this plugin learns which pane a tab
 * sits in and how tabs are ordered inside it. Only the on-screen session is in
 * the document, which is exactly the scope these actions act on.
 *
 * If no chip is found inside a pane element, the chips' own document order is
 * used as a single sequence: "close to the right" stays meaningful, and any tab
 * that cannot be placed is still listed by the manager rather than dropped.
 */
function readPanes() {
  if (typeof document === 'undefined') return [];
  const panes = [];
  let found = 0;
  for (const element of document.querySelectorAll('[data-dockkit-pane],[data-dockkit-float]')) {
    const paneId = element.dataset.dockkitPane ?? element.dataset.dockkitFloat;
    if (typeof paneId !== 'string' || paneId === '') continue;
    const tabs = [];
    for (const chip of element.querySelectorAll('[data-dockkit-tab]')) {
      const tabId = chip.dataset.dockkitTab;
      if (typeof tabId === 'string' && tabId !== '' && !tabs.includes(tabId)) tabs.push(tabId);
    }
    if (tabs.length === 0) continue;
    found += tabs.length;
    panes.push({ paneId, host: element.dataset.dockkitFloat === undefined ? 'dock' : 'float', tabs });
  }
  if (found > 0) return panes;

  const ordered = [];
  for (const chip of document.querySelectorAll('[data-dockkit-tab]')) {
    const tabId = chip.dataset.dockkitTab;
    if (typeof tabId === 'string' && tabId !== '' && !ordered.includes(tabId)) ordered.push(tabId);
  }
  return ordered.length > 1 ? [{ paneId: 'document', host: 'dock', tabs: ordered }] : [];
}

/** Where a tab sits in the live panes, or `undefined` when it is not on screen. */
function locateTab(panes, tabId) {
  for (const pane of panes) {
    const index = pane.tabs.indexOf(tabId);
    if (index >= 0) return { pane, index };
  }
  return undefined;
}

/**
 * Subscribe to a snapshot source and re-render on change.
 *
 * Prefers React 18's `useSyncExternalStore` and falls back to a state mirror,
 * so the plugin still works if the shell ships an older React.
 * @param source - any `{ getSnapshot, subscribe }` observable.
 */
function useStoreValue(source) {
  const read = React.useMemo(() => () => source.getSnapshot(), [source]);
  const subscribe = React.useMemo(() => (onChange) => source.subscribe(onChange), [source]);
  if (typeof React.useSyncExternalStore === 'function') {
    return React.useSyncExternalStore(subscribe, read, read);
  }
  const [value, setValue] = React.useState(read);
  React.useEffect(() => {
    setValue(read());
    return source.subscribe(() => setValue(read()));
  }, [source, read]);
  return value;
}

//#endregion

//#region reopen ledger

/**
 * Remember what closed, so a tab can be reopened the way a browser reopens one.
 *
 * Two public facts make this possible with no private API:
 *   - `ctx.sidebarRight.openTabs` publishes `{ sessionId, tabId, kind, contentId }`
 *     for every open tab and is republished on every store commit, so diffing
 *     two snapshots names exactly what disappeared — including tabs the user
 *     closed from the shipped menu or with Cmd+W.
 *   - A record's `contentId` is the address the tab was opened under (a
 *     `dsh-resource://…` URI, or `sidebar://<kind>` for a page), which is
 *     precisely what `openResource` / `openTab` accept to open it again.
 *
 * Titles are not part of that inventory, so they are cached from `tabsIn` while
 * each tab is still alive — a tab must be known before it can be missed.
 */
function createLedger(sidebar) {
  /** sessionId -> oldest-first array of `{ kind, contentId, title, at }`. */
  const closed = new Map();
  /** `<sessionId>\0<tabId>` -> the title captured while that tab was open. */
  const titles = new Map();
  let previous = new Map();

  const keyOf = (sessionId, tabId) => `${sessionId}\u0000${tabId}`;

  const push = (row) => {
    const name = titles.get(keyOf(row.sessionId, row.tabId)) ?? derivedTitle(row);
    const list = closed.get(row.sessionId) ?? [];
    list.push({ kind: row.kind, contentId: row.contentId, title: name, at: Date.now() });
    if (list.length > CLOSED_LIMIT) list.splice(0, list.length - CLOSED_LIMIT);
    closed.set(row.sessionId, list);
  };

  /** Diff the inventory against the previous read, then refresh cached titles. */
  const sync = () => {
    const snapshot = attempt('read open tabs', () => sidebar.openTabs.getSnapshot()) ?? [];
    const next = new Map();
    const sessions = new Set();
    for (const row of snapshot) {
      if (!row || typeof row.sessionId !== 'string' || typeof row.tabId !== 'string') continue;
      next.set(keyOf(row.sessionId, row.tabId), row);
      sessions.add(row.sessionId);
    }
    // A key that was present and is now gone is a close we get to remember.
    for (const [key, row] of previous) {
      if (!next.has(key)) push(row);
    }
    previous = next;

    for (const sessionId of sessions) {
      const rows = sessionTabs(sidebar, sessionId);
      const live = new Set();
      for (const row of rows) {
        const key = keyOf(sessionId, row.id);
        titles.set(key, row.title);
        live.add(key);
      }
      const prefix = `${sessionId}\u0000`;
      for (const key of titles.keys()) {
        if (key.startsWith(prefix) && !live.has(key)) titles.delete(key);
      }
    }
  };

  /** Open one remembered entry again, removing it only once the open succeeded. */
  const open = (entry) => {
    if (entry === undefined) return false;
    const opened = attempt('reopen tab', () => {
      if (typeof entry.contentId === 'string' && entry.contentId.startsWith('dsh-resource://')) {
        sidebar.openResource(entry.contentId);
      } else {
        sidebar.openTab(entry.kind);
      }
      return true;
    });
    return opened === true;
  };

  /** The closed stack for a session, oldest first; always an array. */
  const listOf = (sessionId) => (typeof sessionId === 'string' ? (closed.get(sessionId) ?? []) : []);

  return {
    sync,
    /** The closed stack for a session, oldest first; `[]` when there is none. */
    list: listOf,
    /** Reopen the newest closed tab of a session. */
    reopenNewest(sessionId) {
      const list = listOf(sessionId);
      const entry = list[list.length - 1];
      if (entry === undefined || !open(entry)) return false;
      list.pop();
      return true;
    },
    /** Reopen one specific remembered entry; it leaves the stack only on success. */
    reopen(sessionId, entry) {
      const list = listOf(sessionId);
      const index = list.indexOf(entry);
      if (index < 0 || !open(entry)) return false;
      list.splice(index, 1);
      return true;
    },
  };
}

//#endregion

//#region actions

/** Close a batch of tabs one at a time; a tab the column protects is a no-op. */
function closeMany(sidebar, tabIds) {
  let closed = 0;
  for (const tabId of tabIds) {
    const ok = attempt(`close ${tabId}`, () => {
      sidebar.close(tabId);
      return true;
    });
    if (ok === true) closed += 1;
  }
  return closed;
}

/**
 * The context tab's pane and its neighbours inside that pane, plus every other
 * tab in the session. `undefined` when the tab is not currently placed in a
 * pane, which is the honest signal that left/right have no meaning here — and
 * that we cannot tell whether the tab is docked or floating.
 */
function neighbours(sidebar, sessionId, tabId, panes) {
  const located = locateTab(panes, tabId);
  if (located === undefined) return undefined;
  return {
    pane: located.pane,
    left: located.pane.tabs.slice(0, located.index),
    right: located.pane.tabs.slice(located.index + 1),
    others: sessionTabs(sidebar, sessionId)
      .map((row) => row.id)
      .filter((id) => id !== tabId),
  };
}

//#endregion

//#region per-tab menu

/**
 * Extra rows appended to the docking kit's own per-tab menu.
 *
 * The kit renders its layout actions first (focus, split, close), so these rows
 * are content-level management. They carry **no icons**: the kit's own rows have
 * none (`dock.closeTab` is plain "关闭"), and matching that keeps the menu
 * reading as one list rather than two.
 *
 * Everything comes from the closure: the seat hands the component nothing but
 * `{ tab, dismiss }` and framework shares, and the props must never be spread
 * onto DOM.
 *
 * One thing here is genuinely new rather than a convenience: "float this tab"
 * has no menu entry anywhere in the product — the kit only exposes floating
 * through the drag gesture, and its dictionary has no label for it
 * (`dock.dockFloat` is the float panel's own "send back" button). The inverse
 * row appears for a floating tab so the pair sits in one place.
 */
function createTabActions(sidebar, t, ledger) {
  const { MenuItemButton, writeClipboard } = PRIMITIVES;

  return function TabActions(props) {
    const tab = props?.tab;
    const dismiss = typeof props?.dismiss === 'function' ? props.dismiss : () => {};
    if (!tab || typeof tab.id !== 'string') return null;

    const sessionId = sidebar.mounted.getSnapshot();
    const split = neighbours(sidebar, sessionId, tab.id, readPanes());
    const closed = ledger.list(sessionId);
    const rows = [];
    /** Close the menu first, then act, so the list never mutates under it. */
    const run = (fn) => () => {
      dismiss();
      attempt('tab action', fn);
    };

    rows.push(
      h(
        MenuItemButton,
        {
          key: 'others',
          separatorBefore: true,
          disabled: split === undefined || split.others.length === 0,
          onSelect: run(() => closeMany(sidebar, split.others)),
        },
        t('menu.closeOthers'),
      ),
    );

    if (split !== undefined) {
      const floating = split.pane.host === 'float';
      rows.push(
        h(
          MenuItemButton,
          {
            key: 'left',
            disabled: split.left.length === 0,
            onSelect: run(() => closeMany(sidebar, split.left)),
          },
          t('menu.closeLeft'),
        ),
        h(
          MenuItemButton,
          {
            key: 'right',
            disabled: split.right.length === 0,
            onSelect: run(() => closeMany(sidebar, split.right)),
          },
          t('menu.closeRight'),
        ),
        h(
          MenuItemButton,
          {
            key: floating ? 'unfloat' : 'float',
            separatorBefore: true,
            onSelect: run(() => {
              // `float` takes a tab; `dock` takes the floating pane. Both
              // default sensibly: no rect means the kit cascades the panel.
              if (floating) sidebar.dock(split.pane.paneId);
              else sidebar.float(tab.id);
            }),
          },
          t(floating ? 'menu.unfloat' : 'menu.float'),
        ),
      );
    }

    rows.push(
      h(
        MenuItemButton,
        {
          key: 'copy',
          separatorBefore: true,
          disabled: typeof tab.contentId !== 'string' || tab.contentId === '',
          onSelect: run(() => {
            if (typeof writeClipboard === 'function') void writeClipboard(tab.contentId);
          }),
        },
        t('menu.copyAddress'),
      ),
      h(
        MenuItemButton,
        {
          key: 'reopen',
          disabled: closed.length === 0,
          onSelect: run(() => ledger.reopenNewest(sessionId)),
        },
        t('menu.reopen'),
      ),
      h(
        MenuItemButton,
        {
          key: 'all',
          separatorBefore: true,
          danger: true,
          // The context tab goes last so the column only collapses once
          // everything else is already gone.
          onSelect: run(() => {
            const all = sessionTabs(sidebar, sessionId).map((row) => row.id);
            closeMany(sidebar, all.filter((id) => id !== tab.id));
            closeMany(sidebar, [tab.id]);
          }),
        },
        t('menu.closeAll'),
      ),
    );

    return h(React.Fragment, null, rows);
  };
}

//#endregion

//#region manager page

/**
 * One listed tab: the label focuses it, the trailing control closes it.
 *
 * Rows carry no leading glyph. A tab record's `kind` is opaque here, so the best
 * a glyph could do is guess from the address — and a guess that is wrong reads
 * as information. The title is the information.
 */
function TabRow({ sidebar, tab, label, jumpLabel, closeLabel, onClose }) {
  const { Tooltip, IconCloseOutlineRegular } = PRIMITIVES;
  return h(
    'div',
    { className: 'dsh-st-row' },
    h(
      'button',
      {
        type: 'button',
        className: 'dsh-st-rowLabel',
        title: jumpLabel,
        onClick: () => attempt('focus tab', () => sidebar.focus(tab.id)),
      },
      label,
    ),
    h(
      'span',
      { className: 'dsh-st-rowAction' },
      h(
        Tooltip,
        { label: closeLabel },
        h(
          'button',
          {
            type: 'button',
            'aria-label': closeLabel,
            style: { display: 'flex', padding: 2, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' },
            onClick: onClose,
          },
          h(IconCloseOutlineRegular, { size: 14 }),
        ),
      ),
    ),
  );
}

/**
 * The manager page body.
 *
 * It follows the on-screen session reactively, so moving between sessions
 * re-derives everything, and it groups tabs by the live panes for the same
 * reason the menu needs them. A tab the DOM cannot place is listed under
 * "other" rather than dropped.
 *
 * Icons appear only inside controls that do something (close, reopen, collapse);
 * page headings and list rows are text, matching the rest of the column.
 */
function createManagerBody(sidebar, t, ledger) {
  const { Button, IconCloseOutlineRegular, IconRefreshOutlineRegular, IconPanelLeftOutlineRegular } = PRIMITIVES;

  return function ManagerBody() {
    const sessionId = useStoreValue(sidebar.mounted);
    // Membership drives re-renders; titles and pane placement are read fresh
    // during render instead of being mirrored into state that could go stale.
    useStoreValue(sidebar.openTabs);

    const rows = sessionTabs(sidebar, sessionId);
    const panes = readPanes();
    const closed = ledger.list(sessionId);
    const closeGroup = (ids) => () => closeMany(sidebar, ids);
    const labelOf = (tab) => (typeof tab.title === 'string' && tab.title !== '' ? tab.title : derivedTitle(tab));

    const placed = new Set();
    const groups = [];
    panes.forEach((pane, index) => {
      const tabs = pane.tabs.map((id) => rows.find((row) => row.id === id)).filter(Boolean);
      if (tabs.length === 0) return;
      for (const tab of tabs) placed.add(tab.id);
      groups.push({ pane, index, tabs });
    });
    const ungrouped = rows.filter((row) => !placed.has(row.id));

    const listed = (tab, key) =>
      h(TabRow, {
        key,
        sidebar,
        tab,
        label: labelOf(tab),
        jumpLabel: t('manager.jump'),
        closeLabel: t('manager.closeOne'),
        onClose: () => closeMany(sidebar, [tab.id]),
      });

    const head = h(
      'div',
      { className: 'dsh-st-head' },
      h('span', { className: 'dsh-st-heading' }, t('manager.heading')),
      h('span', { className: 'dsh-st-count' }, `${rows.length} ${t('manager.openSuffix')}`),
      h(
        'span',
        { className: 'dsh-st-headActions' },
        h(
          Button,
          {
            size: 'sm',
            variant: 'outline',
            icon: h(IconCloseOutlineRegular, { size: 14 }),
            disabled: rows.length === 0,
            onClick: closeGroup(rows.map((row) => row.id)),
          },
          t('manager.closeAll'),
        ),
        h(
          Button,
          {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconPanelLeftOutlineRegular, { size: 14 }),
            onClick: () => attempt('collapse column', () => sidebar.toggleExpanded()),
          },
          t('manager.collapse'),
        ),
      ),
    );

    const sections = [];
    if (rows.length === 0) {
      sections.push(h('div', { key: 'empty', className: 'dsh-st-empty' }, t('manager.empty')));
    }
    for (const group of groups) {
      sections.push(
        h(
          'div',
          { key: `pane-${group.pane.paneId}`, className: 'dsh-st-group' },
          h(
            'div',
            { className: 'dsh-st-groupHead' },
            h('span', null, `${t('manager.paneLabel')} ${group.index + 1} · ${t(group.pane.host === 'float' ? 'manager.paneFloat' : 'manager.paneDock')}`),
            h(
              'span',
              { className: 'dsh-st-groupAction' },
              group.pane.host === 'float'
                ? h(
                    Button,
                    {
                      size: 'sm',
                      variant: 'ghost',
                      onClick: () => attempt('dock pane', () => sidebar.dock(group.pane.paneId)),
                    },
                    t('manager.undock'),
                  )
                : null,
              h(Button, { size: 'sm', variant: 'ghost', onClick: closeGroup(group.tabs.map((tab) => tab.id)) }, t('manager.closePane')),
            ),
          ),
          group.tabs.map((tab) => listed(tab, tab.id)),
        ),
      );
    }
    if (ungrouped.length > 0) {
      sections.push(
        h(
          'div',
          { key: 'ungrouped', className: 'dsh-st-group' },
          h('div', { className: 'dsh-st-groupHead' }, h('span', null, t('manager.ungrouped'))),
          ungrouped.map((tab) => listed(tab, tab.id)),
        ),
      );
    }

    sections.push(
      h(
        'div',
        { key: 'closed', className: 'dsh-st-group' },
        h('div', { className: 'dsh-st-sep' }),
        h('div', { className: 'dsh-st-groupHead' }, h('span', null, t('manager.closedHeading'))),
        closed.length === 0
          ? h('div', { className: 'dsh-st-empty' }, t('manager.closedEmpty'))
          : closed
              .slice()
              .reverse()
              .map((entry, index) =>
                h(
                  'div',
                  { key: `closed-${entry.contentId}-${index}`, className: 'dsh-st-row' },
                  h('span', { className: 'dsh-st-rowLabel', title: entry.title }, entry.title),
                  h(
                    'span',
                    { className: 'dsh-st-rowAction', style: { opacity: 1 } },
                    h(
                      Button,
                      {
                        size: 'sm',
                        variant: 'ghost',
                        icon: h(IconRefreshOutlineRegular, { size: 14 }),
                        onClick: () => ledger.reopen(sessionId, entry),
                      },
                      t('manager.reopen'),
                    ),
                  ),
                ),
              ),
      ),
    );

    return h('div', { className: 'dsh-st-page' }, head, ...sections);
  };
}

//#endregion

//#region shortcuts

/**
 * Register the keyboard commands.
 *
 * `ctx.shortcuts.register` rejects a default binding that overlaps any other
 * command's default on any supported runtime/platform, and throws at
 * registration time. This plugin cannot know which commands a given profile
 * ships, so a rejected default degrades in two steps — desktop-only, then
 * unbound. An unbound command still appears in the shortcut settings for the
 * user to bind by hand, which beats failing the whole registration.
 */
function registerShortcuts(shortcuts, sidebar, t, ledger, openManager) {
  const disposers = [];
  const unbound = [];

  const register = (command) => {
    const desktop = {};
    for (const platform of ['macos', 'windows', 'linux']) {
      const binding = command.defaults[`desktop:${platform}`];
      if (binding !== undefined) desktop[`desktop:${platform}`] = binding;
    }
    const ladders = [command.defaults, desktop, {}];
    for (let step = 0; step < ladders.length; step += 1) {
      try {
        disposers.push(shortcuts.register({ ...command, defaults: ladders[step] }));
        if (step > 0) unbound.push(`${command.id} (defaults reduced)`);
        return;
      } catch (error) {
        const last = step === ladders.length - 1;
        if (last) {
          console.warn(`[${PLUGIN_ID}] could not register command ${command.id}`, error);
          return;
        }
      }
    }
  };

  const forEveryDevice = (desktopBinding, webBinding) => ({
    'desktop:macos': desktopBinding,
    'desktop:windows': desktopBinding,
    'desktop:linux': desktopBinding,
    'web:macos': webBinding,
    'web:windows': webBinding,
    'web:linux': webBinding,
  });
  const key = (code, modifiers) => ({ code, modifiers });
  const regions = ['page', 'editable', 'terminal'];
  const blocked = (reason) => ({ status: 'blocked', reason });

  register({
    id: 'sidebarTabs.closeOthers',
    label: () => t('command.closeOthers'),
    aliases: ['tabs', 'close others', 'right sidebar'],
    defaults: forEveryDevice(key('KeyW', ['primary', 'alt']), key('KeyW', ['primary', 'alt', 'shift'])),
    regions,
    modals: [],
    resolve: ({ target: element }) => {
      const target = sidebar.focusedTarget(element ?? null);
      if (target === undefined) return blocked(t('command.noFocus'));
      const others = sessionTabs(sidebar, sidebar.mounted.getSnapshot())
        .map((row) => row.id)
        .filter((id) => id !== target.tabId);
      if (others.length === 0) return blocked(t('command.unavailable'));
      return {
        status: 'handled',
        run: () => {
          if (sidebar.isTargetCurrent(target)) closeMany(sidebar, others);
        },
      };
    },
  });

  register({
    id: 'sidebarTabs.closeAll',
    label: () => t('command.closeAll'),
    aliases: ['tabs', 'close all', 'right sidebar'],
    defaults: forEveryDevice(key('KeyW', ['primary', 'alt', 'shift']), key('Backspace', ['primary', 'alt', 'shift'])),
    regions,
    modals: [],
    resolve: ({ target: element }) => {
      const target = sidebar.focusedTarget(element ?? null);
      if (target === undefined) return blocked(t('command.noFocus'));
      const ids = sessionTabs(sidebar, sidebar.mounted.getSnapshot()).map((row) => row.id);
      if (ids.length === 0) return blocked(t('command.unavailable'));
      return {
        status: 'handled',
        run: () => {
          if (sidebar.isTargetCurrent(target)) closeMany(sidebar, ids);
        },
      };
    },
  });

  register({
    id: 'sidebarTabs.reopen',
    label: () => t('command.reopen'),
    aliases: ['tabs', 'reopen', 'right sidebar'],
    defaults: forEveryDevice(key('KeyT', ['primary', 'shift']), key('KeyT', ['primary', 'alt', 'shift'])),
    regions,
    modals: [],
    resolve: () => {
      const sessionId = sidebar.mounted.getSnapshot();
      if (sessionId === undefined) return blocked(t('command.noSession'));
      if (ledger.list(sessionId).length === 0) return blocked(t('command.nothingToReopen'));
      return {
        status: 'handled',
        run: () => ledger.reopenNewest(sidebar.mounted.getSnapshot()),
      };
    },
  });

  register({
    id: 'sidebarTabs.manager',
    label: () => t('command.manager'),
    aliases: ['tabs', 'tab manager', 'right sidebar'],
    defaults: forEveryDevice(key('KeyM', ['primary', 'alt']), key('KeyM', ['primary', 'alt', 'shift'])),
    regions,
    modals: [],
    resolve: () => {
      if (sidebar.mounted.getSnapshot() === undefined) return blocked(t('command.noSession'));
      return { status: 'handled', run: () => openManager() };
    },
  });

  return {
    dispose() {
      for (const dispose of disposers.reverse()) attempt('dispose shortcut', dispose);
    },
    unbound,
  };
}

//#endregion

//#region media renderers

/**
 * Renderer identity for the media preview, used both as the document-preview
 * implementation name and as the key its body registers under.
 */
const MEDIA_ID = `${PLUGIN_ID}/media`;
/** Where the Host half mints one signed stream URL. */
const MEDIA_SIGN_PATH = '/api/sidebar-tabs/media/sign';
/** File suffixes each media type covers, in the order the preview advertises them. */
const MEDIA_EXTENSIONS = {
  video: ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus'],
};

/** Media type per extension, matching the Host's own table. */
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

/** Every suffix this plugin claims, deduplicated. */
const MEDIA_SUFFIXES = Object.freeze([...new Set([...MEDIA_EXTENSIONS.video, ...MEDIA_EXTENSIONS.audio])]);

/**
 * Read one `dsh-resource://file/…` address back into the Session and path the
 * Host half must authorize.
 *
 * The grammar is the one `@deepseek-ai/dsh-util-workspace-path` owns: the path
 * may be absolute, so leading slashes are preserved, and each segment is
 * percent-decoded. This bundle carries its own copy rather than importing that
 * package, the same way every other cross-package reference in a client bundle
 * here is a type or a copy, never a runtime import.
 * @param address - a tab's content address.
 * @returns the parts, or `undefined` for a non-file or malformed address.
 */
function parseFileAddress(address) {
  if (typeof address !== 'string') return undefined;
  const withoutSuffix = address.replace(/[?#].*$/su, '');
  if (!withoutSuffix.startsWith('dsh-resource://file/')) return undefined;
  const segments = withoutSuffix.slice('dsh-resource://file/'.length).split('/');
  const scope = segments.shift();
  if (scope !== 'session') return undefined;
  const rawSession = segments.shift();
  if (rawSession === undefined || rawSession === '' || segments.length === 0) return undefined;
  try {
    const sessionId = decodeURIComponent(rawSession);
    const filePath = segments.map(decodeURIComponent).join('/');
    // A trailing slash decodes to an empty or bare-root path, which names no
    // file: the Host would answer `not-regular-file`, and asking it to is a
    // worse error than refusing the address here.
    if (filePath === '' || filePath === '/') return undefined;
    return { sessionId, path: filePath };
  } catch {
    return undefined;
  }
}

/** Basename of a `/`-separated path. */
function baseNameOf(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Resolve a file path to the media type its bytes will be served as.
 * @param path - decoded workspace path.
 * @returns the media type, or `undefined` for a suffix this plugin does not play.
 */
function mediaTypeOf(path) {
  const name = path.replaceAll('\\', '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return MEDIA_TYPES.get(name.slice(dot + 1).toLowerCase());
}

/**
 * Ask the Host half for a signed stream URL.
 *
 * The request authorizes a path and is answered with a URL a media element can
 * use directly; the plugin never holds file bytes. A failure is reported with
 * the Host's own error code, which is what a user can act on (`unreadable` for a
 * missing file, `unsupported-media` for an extension this build does not play).
 * @param sessionId - authorizing Session.
 * @param path - workspace-relative or absolute path.
 * @param signal - the mounting component's cancellation.
 * @returns the URL, or a failure message.
 */
async function requestMediaUrl(sessionId, path, signal) {
  const response = await fetch(MEDIA_SIGN_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, path }),
    signal,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok || typeof payload?.url !== 'string') {
    return { ok: false, detail: String(payload?.detail ?? payload?.error ?? `HTTP ${response.status}`) };
  }
  return { ok: true, url: payload.url, mediaType: typeof payload.mediaType === 'string' ? payload.mediaType : undefined };
}

/**
 * The media document body.
 *
 * It owns no loading itself: the Host streams the file to the element, which
 * asks for the byte ranges it wants and can seek without ever buffering the
 * whole file. That is also why this renderer declares `bytes-complete` loading
 * and then ignores the prepared content — the seat requires a load mode, and the
 * shared byte window is exactly what it must not use.
 * @param props - document address, prepared content, and locale.
 * @returns a native player, or a status line.
 */
function MediaBody({ content, resourceAddress, t }) {
  const file = React.useMemo(() => parseFileAddress(resourceAddress), [resourceAddress]);
  const path = file?.path;
  const mediaType = path === undefined ? undefined : mediaTypeOf(path);
  const isAudio = mediaType !== undefined && mediaType.startsWith('audio/');
  const [view, setView] = React.useState({ revision: 0, state: { kind: 'loading' } });

  React.useEffect(() => {
    if (file === undefined || mediaType === undefined) return undefined;
    const controller = new AbortController();
    let current = true;
    let revision = 0;
    const publish = (state) => {
      if (!current) return;
      setView((previous) =>
        previous.revision === revision && previous.state.kind === state.kind && previous.state.detail === state.detail
          ? previous
          : { revision, state },
      );
    };
    // Only reset to loading when a different file is being asked for: the
    // dependency array re-runs this effect whenever the memoized file object
    // changes, which is not the same thing as a new request.
    setView((previous) => (previous.state.kind === 'loading' ? previous : { revision, state: { kind: 'loading' } }));
    requestMediaUrl(file.sessionId, file.path, controller.signal)
      .then((result) => {
        if (!current) return;
        revision += 1;
        if (result.ok) publish({ kind: 'ready', url: result.url });
        else publish({ kind: 'failed', detail: result.detail });
      })
      .catch((error) => {
        if (!current || error?.name === 'AbortError') return;
        revision += 1;
        publish({ kind: 'failed', detail: String(error?.message ?? error) });
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [file, mediaType]);

  const source = view.state;

  if (file === undefined) return h('p', { className: 'dsh-st-mediaStatus', role: 'alert' }, t('media.unsupported'));
  if (mediaType === undefined) return h('p', { className: 'dsh-st-mediaStatus', role: 'alert' }, t('media.unsupported'));

  const name = baseNameOf(path);
  const element =
    source.kind === 'ready'
      ? h(isAudio ? 'audio' : 'video', {
          className: 'dsh-st-mediaFrame',
          src: source.url,
          controls: true,
          playsInline: true,
          preload: 'metadata',
          'aria-label': t(isAudio ? 'media.audioLabel' : 'media.videoLabel', { name }),
        })
      : undefined;

  const status =
    source.kind === 'loading'
      ? t('media.opening')
      : source.kind === 'failed'
        ? `${t('media.failed')} (${source.detail})`
        : undefined;

  // The status line is keyed by state so a new attempt remounts it rather than
  // reusing a node the browser may already have hidden.
  return h(
    'div',
    {
      className: isAudio ? 'dsh-st-media dsh-st-mediaAudio' : 'dsh-st-media',
      'data-media-state': source.kind,
      'data-media-preview': mediaType,
    },
    element,
    status === undefined
      ? undefined
      : h('p', { className: 'dsh-st-mediaStatus', role: source.kind === 'failed' ? 'alert' : 'status' }, status),
  );
}

/**
 * Describe the media renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns metadata for complete media files.
 */
function mediaDefinition(title) {
  return {
    id: MEDIA_ID,
    extensions: MEDIA_SUFFIXES,
    priority: 'extension',
    title,
    loading: 'bytes-complete',
    wrap: false,
  };
}

/**
 * Register the media renderer's dictionaries, metadata, and body.
 *
 * The metadata goes through the same public registry the shipped renderers use,
 * in the `extension` band, which is what lets it take video suffixes away from
 * the plain-text fallback. The body is registered through the slot registry's
 * standard `inject` form, so a missing child slot parks the registration instead
 * of failing this plugin's whole bundle.
 * @param ctx - client context carrying `documentPreviews` and the slot registry.
 */
function installMediaPreview(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => {
    const disposeMetadata = ctx.documentPreviews.register(mediaDefinition(() => t('media.video')));
    const disposeBody = ctx.slots.inject('sidebar.right.tab.document', () =>
      ctx.slots.register({ name: 'sidebar.right.tab.document', key: MEDIA_ID, locale: NS }, MediaBody),
    );
    console.info(`[${PLUGIN_ID}] media preview ready — video and audio stream from the Host`);
    return () => {
      disposeBody();
      disposeMetadata();
    };
  }, `${PLUGIN_ID}: media preview`);
}

//#endregion

/**
 * The plugin object the client loader mounts.
 * @returns a Cordis client plugin with its required services declared.
 */
function createPlugin() {
  return {
    // Waiting on these services guarantees the right sidebar's navigation face,
    // its tab registry and the slot registry are up before anything registers.
    inject: ['slots', 'locale', 'shortcuts', 'sidebarRight', 'sidebarRightTabs'],
    apply(ctx) {
      installStyle();

      const t = ctx.locale.bind(NS);
      const sidebar = ctx.sidebarRight;
      const ledger = createLedger(sidebar);

      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), `${PLUGIN_ID}: copy`);

      // Keep the reopen ledger warm while the plugin is mounted: a tab must be
      // known to the ledger before it can be remembered as closed.
      ctx.effect(() => {
        ledger.sync();
        const unsubscribe = sidebar.openTabs.subscribe(() => ledger.sync());
        return () => unsubscribe();
      }, `${PLUGIN_ID}: reopen ledger`);

      // Cordis calls `apply` synchronously and requires every `ctx.effect`
      // callback to return a disposer function (or null, a thenable, or an
      // iterator). Returning anything else — a plain object, say — raises
      // `TypeError("Invalid effect")` and aborts `apply` entirely, which in the
      // browser looks like "the plugin registered nothing at all". So the
      // summary this function wants to log is kept in a plain variable instead.
      const mounted = { unbound: [] };

      ctx.effect(() => {
        const disposeMenu = ctx.slots.inject('sidebar.right.tab.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.right.tab.menu.item', id: `${PLUGIN_ID}/menu`, order: 10, locale: NS },
            createTabActions(sidebar, t, ledger),
          ),
        );

        // The manager is a tab type like any other: a static definition, then
        // its keyed body seat, both through the same public two-stage path the
        // shipped page types use.
        const disposeType = ctx.sidebarRightTabs.register({
          id: MANAGER_ID,
          kind: MANAGER_KIND,
          priority: 'extension',
          title: () => t('manager.title'),
          guide: [
            {
              id: 'manager',
              order: 40,
              title: () => t('manager.title'),
              description: () => t('manager.guide.description'),
            },
          ],
        });

        const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: MANAGER_ID, locale: NS }, createManagerBody(sidebar, t, ledger)),
        );

        const openManager = () => attempt('open manager', () => sidebar.openTab(MANAGER_KIND));
        const commands = registerShortcuts(ctx.shortcuts, sidebar, t, ledger, openManager);
        mounted.unbound = commands.unbound;

        return () => {
          commands.dispose();
          disposeBody();
          disposeType();
          disposeMenu();
        };
      }, `${PLUGIN_ID}: tab management`);

      // The media renderer is not gated on this plugin's other seats: it only
      // needs services the shipped document preview provides. Waiting through
      // `ctx.inject` keeps the tab-management half working in a composition
      // where that preview is absent, and re-runs the registration if the
      // preview is ever unloaded and loaded again.
      ctx.inject(['documentPreviews'], (mediaCtx) => installMediaPreview(mediaCtx));

      console.info(
        `[${PLUGIN_ID}] mounted — right-sidebar tab management ready` +
          (mounted.unbound.length > 0 ? `; reduced default bindings: ${mounted.unbound.join(', ')}` : ''),
      );
    },
  };
}
