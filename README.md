# dsh-plugin-sidebar-tabs

给 DeepSeek Harness 右侧栏的标签加上浏览器式的管理能力：批量关闭、浮出为浮窗、重新打开已关闭的
标签、以及一个标签总览页。

## 状态

**过渡期项目。** 本插件的目的，是在 DeepSeek Harness 原生提供右侧栏体验优化之前，把这部分体验
补上。**官方原生提供之后本项目即停止维护**，届时请卸载本插件、改用原生能力。

欢迎 star、fork、PR。

## 安装

DSH 桌面端：**设置 → 插件 → 添加插件**，粘贴：

```
https://github.com/neil-ji/dsh-plugin-sidebar-tabs
```

<img src="docs/images/install-dialog.webp" width="620" alt="「添加插件」对话框：输入框里已填入本仓库的 GitHub 地址，右下角安装源为「中国大陆镜像源」，下方是插件来源可信提醒和「安装」按钮">

装完是这个样子，点「立即启用」：

<img src="docs/images/install-success.webp" width="620" alt="安装完成界面：绿色对勾与「已安装」，地址下方标注「Git 仓库」，展开的安装详情显示安装位置（用户名已隐去）与 pnpm add 输出，底部是「立即启用」按钮">

然后刷新一次页面：按 `F12` → Console → `location.reload()`。

命令行（`web` profile；桌面端的 `desktop` profile 由应用独占管理，只能用插件页）：

```bash
dsh plugin --profile web add https://github.com/neil-ji/dsh-plugin-sidebar-tabs
```

## 能力

- **标签右键菜单**：关闭其它 / 关闭左侧 / 关闭右侧 / 关闭全部、浮出为浮窗（浮窗里则是收回）、
  复制标签地址、重新打开已关闭的标签。
- **标签管理页**（引导页入口）：按分栏列出所有已打开标签，点行跳转、逐个 / 整格 / 全部关闭，
  浮窗可收回，并列出"最近关闭"以便恢复。
- **四个键盘命令**：关闭其它、关闭全部、重新打开、打开标签管理。默认键位与其他命令撞车时会自动
  降级为未绑定，可在设置里自己绑。

## 效果展示

标签右键菜单：

<img src="docs/images/tab-context-menu.webp" width="760" alt="标签右键菜单：关闭其它标签 / 关闭左侧标签 / 关闭右侧标签（无右侧标签时禁用）/ 浮出为浮窗 / 复制标签地址 / 重新打开已关闭的标签 / 关闭全部标签">

「浏览器」标签浮出为浮窗：

<img src="docs/images/browser-float-window.webp" width="700" alt="「浏览器」标签浮出为浮窗：独立窗口卡片，顶部保留后退、前进、刷新与 HTTP(S) 地址栏，右下角可拖拽调整大小">

## 开发

零依赖，不需要打包器。

```bash
npm run build   # src/ -> lib/
npm run check   # 产物与 src/ 不一致时 exit 1
npm test        # 桩件加载产物并驱动 apply()
```

`lib/` 提交进仓库是刻意的：git 安装不跑构建步骤。CI 跑上面两条命令。

实现细节、扩展点、以及踩过的坑见 [docs/notes.md](docs/notes.md)。

## License

[MIT](LICENSE)
