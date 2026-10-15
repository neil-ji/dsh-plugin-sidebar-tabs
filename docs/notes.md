# 实现笔记

README 只讲怎么用。这里是给 fork / 改代码的人看的：用了哪些扩展点、哪些地方是踩出来的、
以及哪些事这套席位面根本做不到。

## 用了哪些扩展席位

| 能力 | 用的席位 / API |
|---|---|
| 每个标签的菜单追加行 | `sidebar.right.tab.menu.item`（list 席位） |
| 新的页类型 | `ctx.sidebarRightTabs.register({ id, kind, title, guide })` |
| 该页类型的正文 | `sidebar.right.pane.tab`（keyed 席位，key = **定义的 id**，不是 kind） |
| 批量关闭 / 聚焦 / 重开 | `ctx.sidebarRight` 的 `close` / `focus` / `openResource` / `openTab` / `tabsIn` / `mounted` / `openTabs` |
| 浮出 / 收回 | `ctx.sidebarRight` 的 `float(tabId)` / `dock(paneId)` |
| 键盘命令 | `ctx.shortcuts.register({ … resolve })` |
| 文案 | `ctx.locale.register(ns, { zh, en })` + `bind(ns)` |
| 文件预览追加渲染器 | `ctx.documentPreviews.register({ id, extensions, priority, title, loading })` |
| 该渲染器的正文 | `sidebar.right.tab.document`（keyed 席位，key = 注册的 id） |
| 媒体字节流 | `ctx.webServer.register({ kind, path, handler })`（Host 半） |
| 读文件字节 | `ctx.workspaceFiles.readBytes(scope, path, { offset, length }, signal)`（Host 半） |
| 会话 → 工作区根 | `ctx.typert.lookups.get('workspaceFileScope').resolve(sessionId)` |

## 三个实现要点

### 1. 菜单席位只给两个 props

`sidebar.right.tab.menu.item` 的占用者只会收到 `{ tab, dismiss }`：没有绑定好的 `useTabInfo`，
也没有注入的 actions（这个席位自己没有 `inject`，渲染调用点也没传 `hookContext`）。所以组件
不依赖任何 props，其余全部从注册时闭包捕获的 `ctx` 取。props 也绝不能 spread 到 DOM 上。

`dismiss()` 必须在动作**之前**调用：菜单是套件的，它只在套件自己的动作上关闭。

图标约定：菜单行不带图标（套件自己的行也没有，`dock.closeTab` 就是纯文字"关闭"），图标只出现在
会做事的控件里。

### 2. "关闭右侧"的顺序是从 DOM 读的

`ctx.sidebarRight` 有意只暴露动作、不暴露布局快照，而 docking kit 不是插件能 `require` 的包。
所以"标签在格子里排第几"靠标签条自己的 `data-dockkit-pane` / `data-dockkit-float` /
`data-dockkit-tab` 属性从 DOM 读取——这正是 `ui-sidebar-right` 自己解析焦点分栏时用的同一组属性。
只有屏幕上的会话在 DOM 里，而这恰好就是这些动作作用的范围。

读不到时按两级降级：退化为整个文档里标签的先后顺序；再不行就**只提供不依赖顺序的操作**
（关闭其它 / 关闭全部 / 复制 / 重开），绝不猜一个可能关错标签的顺序。管理页对读不到分栏的标签
会列进"其它"，不会丢弃。

### 3. "重新打开"覆盖所有关闭方式

订阅 `ctx.sidebarRight.openTabs`（按会话发布 `{ sessionId, tabId, kind, contentId }`，每次 store
提交都重发），对相邻两次快照做差集，就拿到**所有**消失的标签——包括用户用套件自带菜单或 Cmd+W
关掉的。标题不在那份清单里，所以在标签还活着的时候从 `tabsIn(sessionId)` 缓存。

重开时看 `contentId`：以 `dsh-resource://` 开头的走 `openResource(contentId)`，否则是页类型，
走 `openTab(kind)`。资源 tab 的 `contentId` 就是资源地址、页 tab 的就是 `sidebar://<kind>`，
正是两个 open 方法接受的入参。

## 做不到的事

- **标签条本身**：不能加工具栏按钮、不能改标签胶囊的行为、不能中键关闭。套件没有面向格级动作或
  折叠态控件的席位。
- **重命名任意标签**：标题在标签铸造时就固定了，只有注册了 `sidebar.right.pane.tab.title` 席位的
  类型自己才能改。
- **跨设备同步布局**：布局存在浏览器 localStorage 里。
- **拖动重排 / 固定标签**：标签条归 docking kit，没有对应的扩展点。

## 快捷键的降级阶梯

`ctx.shortcuts.register` 在注册时就校验默认键位：与**任意**已注册命令在**任一**运行端/平台上
重叠就直接抛错。插件无法预知一个 profile 里有哪些命令，所以默认键位按三级降级：
全平台 → 仅桌面 → 不绑定。不绑定的命令仍会出现在快捷键设置里让用户自己绑，这比整个注册失败好。

## 构建

零依赖：没有打包器、没有 `node_modules`、没有安装期脚本。

```bash
npm run build   # src/host/client.js + src/host/media-*.js -> lib/index.js，src/client.js -> lib/client.js
npm run check   # 产物与 src/ 不一致时 exit 1
npm test        # 在 Node 里用桩件加载产物并驱动 apply()；另含 token / Range / 路由往返
```

`src/client.js` **不是一个模块**，而是一段"工厂函数体"：`tools/build.mjs` 把它包进

```js
window.__ModuleLoader__.load({ id: 'dsh-plugin-sidebar-tabs', factory: function (require) { … } });
```

并追加 `return createPlugin();`。所以它不写 `import`/`export`，`require` 是信封传进来的参数。

`tools/build.mjs` 会拦两件事，两件都会让插件**静默不加载**：

- bundle 里 `require()` 了一个既不在基座、也没在 `dsh.client.inject` 里声明的包；
- `dsh.client.inject` 里列了**平台基座模块**（如 `@deepseek-ai/dsh-client-ui-primitives`）。
  这类包在 shell 的冻结模块表里，没有自己的 bundle row，`inject` 对它们是无操作。

| 产物 | 是什么 |
|---|---|
| `lib/index.js` | Host 半边：媒体预览的两条 HTTP 路由。标签管理那半边不需要 Host 参与，但没有这一行就没有 `dsh.client` 可扫，客户端半边不会被加载。 |
| `lib/client.js` | 浏览器半边：标签管理 + 媒体渲染器注册 + 播放器正文。 |

`lib/` **提交进仓库**是刻意的：git 安装拿到的是仓库原样，不跑任何构建步骤。也正因为如此，CI 跑
`npm run check`——过期的 bundle 是用户看不见的那种缺陷。

## 媒体预览是怎么接上的

官方预览包 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 把"按后缀挑渲染器"做成了公开
注册表：`ctx.documentPreviews.register(...)` 只登记元数据，正文另外注册到 keyed 席位
`sidebar.right.tab.document`，key 就是元数据的 `id`。排序是 **extension 段 > builtin 段，
然后后缀更长优先**，所以外部插件的 `extension` 注册天然压过内置的纯文本兜底——mp4 不用改
DSH 本体就从"当文本读然后失败"变成"按视频播"。

正文渲染器会收到 `{ resourceAddress, content, wrap, scrollportRef }`。`content` 的类型由元数据的
`loading` 决定：

- `text-pages`：累积的文本前缀（Markdown / 代码 / 纯文本用）；
- `bytes-complete`：整份文件的字节。

**两条路都不能用来放视频**：`bytes-complete` 走 `remote.workspaceFiles.readAll`，默认上限
`maxFileBytes = 32 MiB`，超了直接 `too-large` 失败，而且整份文件以 base64 过线；没有 Range，
也就没有 seek。所以媒体渲染器声明 `bytes-complete`（席位要求一个模式）却**完全不看 `content`**，
真正的字节走 Host 半的流式路由。

### Host 半：签名 URL + Range

```text
POST /api/sidebar-tabs/media/sign     { sessionId, path } -> { url, mediaType, bytes }
GET  /api/sidebar-tabs/media/stream?token=…   bytes，支持 Range / 206 / 416 / HEAD
```

`<video>` 不能带 `Authorization` 头，所以授权只能放进 URL。token 是
`base64url(payload) + "." + HMAC-SHA256(payload)`，payload 里是 `{ session, path, exp, nonce }`，
密钥每个 Host 进程随机生成一次。篡改会打掉签名，重启会让所有旧地址失效。`nonce` 保证同一个文件
两次请求拿到不同的 URL，不会撞上媒体缓存。

读文件不自己开 `node:fs`，而是回到官方的 `workspaceFiles`：

```js
const scope = await ctx.typert.lookups.get('workspaceFileScope').resolve(sessionId);
const window = await ctx.workspaceFiles.readBytes(scope, path, { offset, length }, signal);
```

这样**读权限、沙箱策略、相对路径怎么解析**都由 DSH 决定，插件只负责分页和写响应。`readBytes`
返回的是 base64 窗口，`bytes` 字段给出文件总大小（用它做 `Content-Length`）。

### 字节窗口上限是"发现"出来的，不是假设的

`maxBytes`（默认 2 MiB）是 workspace-files 那一行的配置，插件读不到，而且**超限是抛
`workspace-file/too-large` 拒绝，不是截断**。所以路由第一窗从 1 MiB 试起，被拒就减半，直到
`MIN_CHUNK_BYTES`；成功的宽度在整条响应里沿用。`tests/host-media.mjs` 里的假件照搬了"拒绝而不是
截断"的语义，所以这个自适应逻辑是真被跑过的。

### 为什么 `lib/` 必须自包含

git 安装不跑构建步骤，仓库里有什么就装什么。所以 `tools/build.mjs` 把 `src/host/media-*.js`
**内联**进 `lib/index.js`：每个模块变成一个返回自身导出的 IIFE，`import` 语句被提到文件顶部
（`import` 是模块级声明，留在 IIFE 里是语法错误）。内联模块因此只允许 `node:` 内置导入，构建脚本
会拦下别的东西。这样做的好处是 `files` 列表、单个 tarball、或只拷 `lib/` 的部署都不会缺文件。

## 踩过的坑

### `ctx.effect` 的回调必须返回函数

Cordis 的 `_execute` 只接受四种返回值：函数、`null`/`undefined`、thenable、iterator。**其余一律
`throw new TypeError("Invalid effect")`**。一个不小心返回了普通对象（比如想把若干 disposer 打包装
起来）就会让整个 `apply` 在注册任何东西之前中断——在浏览器里表现为"插件像是没装"，而且没有任何
UI 提示。

`tests/smoke.mjs` 里的 `ctx` 桩件照搬了这个契约，所以这类错误在 `npm test` 阶段就会失败。

### `dsh.client.inject` 不做校验

它只用来钉住"这些包的 bundle 必须先到达"的顺序：查不到的条目**静默跳过**，不报错。会把缺失
提供方当错误拒绝的是 `dsh.client.external`。所以把基座模块写进 `inject` 是无害的噪音（不是故障），
但构建脚本仍然拦它，免得盖住真正的问题。

### `clientModules` 的元数据缓存

它把每个包解析出的 `dsh.client` 声明——**包括 `lib/client.js` 的绝对路径**——缓存到宿主重启为止：

- 改 `package.json` 的 `dsh.client.inject` / `platform`：重启才生效。
- **换安装来源**（例如把本地 `link:` 换成 git 安装）：profile 的依赖记录变了，但缓存的产物路径还是
  旧的。只要旧路径仍存在，一切看起来正常，**实际服务的还是旧目录里的文件**；删掉旧目录则会让
  客户端半边在重启前失效。
- 只改 `lib/*.js` 的内容不受影响：revision 每 500ms 从入口产物的 `mtime/ctime/size` 重算。

全新安装不涉及这一点。

### 桌面端怎么重载页面

桌面端是生产构建，"重新加载页面"菜单项只在开发模式下注册，所以菜单里没有它。但同一个菜单里有
一个**始终注册、加速键 F12** 的隐藏项：

1. 按 **F12** 打开 DevTools；
2. 切到 Console，输入 `location.reload()` 回车。

**新装**一个 client 插件后这一步通常是必须的：增量 HMR 只能*替换*已经成功挂载过的插件，一个从未
成功挂载的行它不接手。控制台里应该打印
`[dsh-plugin-sidebar-tabs] mounted — right-sidebar tab management ready`。

已挂载过的插件则不需要：改 `lib/client.js` 后 HMR 会自己替换（但它只 stat 入口产物，只改同级
chunk 不会被发现）。

## 已知风险

- **`data-dockkit-*` 不是公共契约。** 它是套件内部用来解析焦点的约定；套件改版时这里是第一个会坏的
  地方。坏了会降级，不会误关标签。
- 菜单里的"关闭全部"会把整列最后一个标签也关掉，于是整列收起（套件自己的规则）。恢复用
  `Mod+Shift+T` 或引导页里的"标签管理"。
- 声明了 `@deepseek-ai/cordis` 的 peer 范围 `~4.0.4`。DSH 换大版本后 API 才有可能变，届时安装器
  会直接拒绝，而不是装上一个坏插件。
