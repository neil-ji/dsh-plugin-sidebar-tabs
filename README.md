# dsh-plugin-sidebar-tabs

给 DeepSeek Harness 右侧栏的标签加上浏览器式的管理能力。

右侧栏（`rightbar`）平时只能一个个关标签，而且关掉最后一个标签时整列会收起、连"退回"的入口都没有。
这个插件补上三件事：

1. **每个标签的右键菜单**追加一组内容级操作：关闭其它 / 关闭左侧 / 关闭右侧 /
   浮出为浮窗（浮窗里则是收回到侧边栏）/ 复制标签地址 / 重新打开已关闭的标签 / 关闭全部。
2. **一个"标签管理"页**（右侧栏的一个 tab 类型，同时在引导页注册入口）：按分栏列出所有已打开的
   标签，可点击跳转、逐个关闭、整格关闭、全部关闭，浮窗分栏还多一个"收回"，并列出"最近关闭"
   以便恢复。
3. **四个键盘命令**：关闭其它、关闭全部、重新打开、打开标签管理。

## 两处视觉约定

- **菜单行不带图标。** 套件自己的行也没有（`dock.closeTab` 就是纯文字"关闭"），所以加图标会让
  同一个菜单读起来像两段拼起来的。测试里有一条断言直接锁住这件事。
- **图标只出现在会做事的控件里**（管理页的关闭 / 重开 / 收起按钮），标题和列表行一律纯文字。
  原先列表行前面有一个按地址猜出来的类型图标，那个猜测错了会被当成信息读，已去掉。

"浮出为浮窗"是这里唯一**产品里原本没有入口**的能力：套件只通过拖拽手势提供浮出，
它的字典里连一个对应的文案键都没有（`dock.dockFloat` 是浮窗自己头部的"收回到侧边栏"按钮）。

## 安装

在 DSH 桌面端打开 **设置 → 插件 → 添加插件**，把仓库地址粘进去：

```
https://github.com/neil-ji/dsh-plugin-sidebar-tabs
```

`pnpm` 形式（本机开发、或 `web` profile 用命令行）也可以，参数名不变：

```bash
dsh plugin --profile web add https://github.com/neil-ji/dsh-plugin-sidebar-tabs.git
dsh plugin --profile web add /path/to/a/local/checkout   # 本地目录会建软链，改 lib/*.js 即时生效
```

注意桌面端的 `desktop` profile 由 Electron 应用独占管理，命令行会被拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

桌面端请一律走应用里的插件页（或让 agent 调 `plugin_manager` 工具）。

安装后右侧栏的**引导页**里会出现"标签管理"入口；装完之后第一次如果没看到变化，刷新一次页面即可
（见下面的[桌面端怎么重载页面](#桌面端怎么重载页面)）。

### 从 git 安装意味着什么

仓库里**提交了构建产物** `lib/`，这是刻意的：git 安装拿到的是仓库原样，不会跑任何构建步骤，
所以 `lib/client.js` 必须在树里。也正因为如此，`.github/workflows/ci.yml` 会跑
`node tools/build.mjs --check`，源码和产物一旦不一致就让 CI 失败——过期的 bundle 是用户看不见的
那种缺陷。

插件没有安装期脚本（没有 `prepare` / `postinstall`），安装只是复制文件。

## 开发

零依赖：仓库里没有打包器、没有 `node_modules`、没有安装期脚本。

```bash
npm run build     # src/host.js -> lib/index.js，src/client.js -> lib/client.js
npm run check     # 只校验产物是否与 src/ 一致（不一致时 exit 1）
npm test          # 在 Node 里用桩件加载产物并驱动 apply()
```

`src/client.js` **不是一个模块**，而是一段"工厂函数体"：`tools/build.mjs` 把它包进

```js
window.__ModuleLoader__.load({ id: 'dsh-plugin-sidebar-tabs', factory: function (require) { … } });
```

并追加 `return createPlugin();`。所以它不写 `import`/`export`，`require` 是信封传进来的参数。
`tools/build.mjs` 会检查两件事，两件都会让插件**静默不加载**：

- bundle 里 `require()` 了一个既不在基座、也没在 `dsh.client.inject` 里声明的包；
- `dsh.client.inject` 里列了**平台基座模块**（如 `@deepseek-ai/dsh-client-ui-primitives`）。
  这类包在 shell 的冻结模块表里，没有自己的 bundle row；`inject` 对它们是无操作。

### 构建产物

| 文件 | 是什么 |
|---|---|
| `lib/index.js` | Host 半边。只有一个空的 `apply`：它的存在只是让 profile 有一行可挂载，从而让 `dsh.client` 被扫进客户端模块图。 |
| `lib/client.js` | 浏览器半边，真正的功能。 |

改动 `lib/client.js` 后，`@deepseek-ai/dsh-client-hmr` 每 500ms 轮询入口产物的 `mtime/ctime/size`，
发现变化就广播 `rebuilt` 帧并替换该插件——**不需要重装，也不需要刷新**。注意两点：HMR 只能*替换*
已经成功挂载过的插件，挂不上的新行它不接手；而且它只 stat 入口产物，只改同级 chunk 不会被发现。

### 桌面端怎么重载页面

桌面端是**生产构建**，"重新加载页面"菜单项只在开发模式下注册，所以菜单里没有它：

```js
...development ? [{ label: …reloadPageMenu, role: "reload" }, …] : []
```

但同一个菜单里有一个**始终注册、加速键 F12** 的隐藏项，所以：

1. 按 **F12** 打开 DevTools；
2. 切到 Console，输入 `location.reload()` 回车。

**新装**一个 client 插件后这一步通常是必须的：增量 HMR 只能替换挂载过的插件，一个从未成功挂载
的行它是不会接手的。控制台里应该打印
`[dsh-plugin-sidebar-tabs] mounted — right-sidebar tab management ready`；如果看到红色报错，那就是
插件没起来的原因。

### 已知的元数据缓存

`clientModules` 会把每个包解析出的 `dsh.client` 声明缓存到宿主重启为止。所以改
`package.json` 的 `dsh.client.inject` / `platform` 之后，要么重启应用，要么重新安装一次；
只改 `lib/*.js` 的内容不受这个缓存影响。

## 设计要点（以及为什么有些事做不到）

### 只走公开的扩展席位

| 能力 | 用的席位 / API |
|---|---|
| 每个标签的菜单追加行 | `sidebar.right.tab.menu.item`（list 席位） |
| 新的页类型 | `ctx.sidebarRightTabs.register({ id, kind, title, guide })` |
| 该页类型的正文 | `sidebar.right.pane.tab`（keyed 席位，key = **定义的 id**，不是 kind） |
| 批量关闭 / 聚焦 / 重开 | `ctx.sidebarRight` 的 `close` / `focus` / `openResource` / `openTab` / `tabsIn` / `mounted` / `openTabs` |
| 浮出 / 收回 | `ctx.sidebarRight` 的 `float(tabId)` / `dock(paneId)` |
| 键盘命令 | `ctx.shortcuts.register({ … resolve })` |
| 文案 | `ctx.locale.register(ns, { zh, en })` + `bind(ns)` |

菜单席位**只**会收到 `{ tab, dismiss }` 两个 owner props，没有绑定好的 `useTabInfo`，也没有注入的
actions。所以组件不依赖任何 props（只读 `tab` 和 `dismiss`），其余全部从注册时闭包捕获的 `ctx` 取。
`dismiss()` 必须在动作之前调用——菜单是套件的，它只在自己的动作上关闭。

### "关闭右侧"的顺序是从 DOM 读的

`ctx.sidebarRight` 有意只暴露动作、不暴露布局快照，而 docking kit 不是一个插件能 `require` 的包。
所以"标签在格子里排第几"这件事，靠标签条自己的 `data-dockkit-pane` / `data-dockkit-float` /
`data-dockkit-tab` 属性从 DOM 读取——这正是 `ui-sidebar-right` 自己解析焦点分栏时用的同一组属性。
只有屏幕上的会话在 DOM 里，而这恰好就是这些动作作用的范围。

读不到时会降级：退化为整个文档里标签的先后顺序；再不行就**只提供不依赖顺序的操作**
（关闭其它 / 关闭全部 / 复制 / 重开），绝不猜一个可能关错标签的顺序。管理页对读不到分栏的标签
会列进"其它"，不会丢弃。

### "重新打开"能覆盖所有关闭方式

订阅 `ctx.sidebarRight.openTabs`（它按会话发布 `{ sessionId, tabId, kind, contentId }`，每次 store
提交都重发），对相邻两次快照做差集，就能拿到**所有**消失的标签——包括用户用套件自带菜单或 Cmd+W
关掉的。标题不在那份清单里，所以在标签还活着的时候从 `tabsIn(sessionId)` 缓存。

重开时：`contentId` 以 `dsh-resource://` 开头的走 `openResource(contentId)`，否则是页类型，
走 `openTab(kind)`。注意 `contentId` 对资源 tab 就是资源地址、对页 tab 就是 `sidebar://<kind>`，
这正是两个 open 方法接受的入参。

### 做不到的事（套件没有对应席位）

- **标签条本身**：不能加工具栏按钮、不能改标签胶囊的行为、不能中键关闭。套件目前没有面向
  格级动作或折叠态控件的席位。
- **重命名任意标签**：标题在标签铸造时就固定了，只有注册了 `sidebar.right.pane.tab.title` 席位的
  类型自己才能改。
- **跨设备同步布局**：布局存在浏览器 localStorage 里，不是这个插件的事。

### 快捷键的降级阶梯

`ctx.shortcuts.register` 会在注册时校验默认键位：与**任意**已注册命令在**任一**运行端/平台上重叠
就直接抛错。插件无法预知一个 profile 里有哪些命令，所以默认键位按三级降级：全平台 → 仅桌面 →
不绑定。不绑定的命令仍然会出现在快捷键设置里让用户自己绑，这比整个注册失败要好。

## 已知风险

- 本插件依赖 `data-dockkit-*` 属性来判断分栏与顺序。这些属性是套件**内部**用来解析焦点的约定，
  官方没有把它们写成公共契约；套件改版时这里是第一个会坏的地方，坏了会降级而不是误关标签。
- 菜单里的"关闭全部"会把整列的最后一个标签也关掉，于是整列收起（这是套件自己的规则）。
  收起后要恢复，用快捷键 `Mod+Shift+T`（重开）或引导页里的"标签管理"入口。
- 声明了 `@deepseek-ai/cordis` 的 peer 范围 `~4.0.4`，与开发所在版本一致。DSH 换大版本后
  `clientModules` 的席位与 API 才有可能变，届时安装器会直接拒绝而不是装上一个坏插件。

## License

[MIT](LICENSE)
