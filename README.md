[README.md](https://github.com/user-attachments/files/32884115/README.md)
# dsh-session-delete

给 DeepSeek Harness 的左侧会话栏加一个「**删除会话**」入口：点一下（悬停行的垃圾桶按钮，或行尾 `...` 菜单）→ 确认 → **真正删除**这个会话。

## 它到底删了什么

DSH 刻意不提供会话删除：会话只能归档、永不删除，持久化层没有删除接口，`session/delete` 只存在于 DSH 作为"外部 agent 客户端"的协议层。所以这个插件是显式的越权扩展，删除的是产品本来会永久保留的这些东西：

| 位置 | 内容 |
|---|---|
| `<DSH_HOME>/sessions/<项目目录名>/<会话 ID>/` | 会话日志（`session.vN.jsonl.zstd` 及同目录内的其他产物） |
| `<DSH_HOME>/storages/session_projcache/sessions/<会话 ID>.json` | 侧栏用的标题/摘要投影缓存 |
| `<DSH_HOME>/storages/workspace.json` | 该会话的工作区记账、归档标记与置顶标记（通过注册表服务摘除，不直接改文件） |

**什么算"正在运行"**（决定 409 拒绝的判定）：不看"会话是否被宿主加载过"——那只是"界面打开过"，
用它当判据会把**空闲但开着的会话**也拒掉（线上出过这个 bug）。现在问的是产品自己的两个信号：

1. `workspace/session-activity` 瀑布（内置「归档」用的同一个）：非空即拒绝，覆盖 轮次 / 子代理 / 后台任务 / 定时提醒
2. agent registry 里 `status === 'running'` 的 agent

两者都拿不到时**放行**（fail-open），避免在缺少提供方的组合里把删除功能彻底堵死。被加载但空闲的会话
允许删除，响应里会带 `loaded: true`。

**删除后那一行是怎么消失的**（这一条踩过坑）：宿主仍持有"已加载"副本时，`sessionQuery` 仍会把它列出来，
而它已从工作区记账里摘掉，于是行会**掉到「未分组」**而不是消失。产品的做法是：会话被 dispose 时发
`api-session/removed`，客户端 `sessions.handleSessionRemoved(id)` 据此丢行。所以本插件删除成功后做两件事：

1. 宿主半 `ctx.emit('api-session/removed', id)` —— 走产品自己的中继（`@deepseek-ai/dsh-api-remotes` 里声明过）
2. 浏览器半在 `sessions.refresh()` **之后**调用 `sessions.handleSessionRemoved(id)`
   —— 顺序不能反：`refreshList()` 启动时会清空待应用的 mutation 列表，先记录移除会被基线覆盖回来

**运行中的会话会被拒绝（HTTP 409）**，包括你当前正在看的这个对话——绝不能一边被 agent 写入一边被删掉。
**删除不可恢复**，没有回收站。

## 结构

```
dsh-session-delete/
├─ package.json          dsh.bundle.patch + dsh.client.platform=web + exports["./client"]
├─ cordis.patch.yml      纯 insert 行，把它插进 profile 的 layer stack
├─ lib/index.js          宿主半：ctx.inject(['webServer']) + 两个 exact 路由
├─ client/client.js      浏览器半：侧栏菜单项 + 悬停按钮 + 确认弹窗 + 结果提示
└─ test/                 两个不需要 DSH 就能跑的校验脚本
```

宿主半只依赖 Node 内建模块并按需读取运行时服务（`sessionPersistence`、`sessions`、`workspaceRegistry`），因此可以被链接到任何 profile 里，不需要 `@deepseek-ai/*` 的依赖解析。路径推导（`projectKey` / `encodeSegment`）是持久化后端同名函数的镜像，`test/host-smoke.mjs` 会断言它与真实目录名逐字一致。

## 安装：先搞清是哪个 profile

DSH 的插件是**按 profile 隔离**的，同一台机器上 `~/.dsh/profiles/` 下可以有多个互不相干的插件世界，而且**同时都装着一份 dshmarket 之类的插件**（版本可能不同）。本机实测：

| profile | 谁在用它 | 怎么装插件 |
|---|---|---|
| `desktop` | **DeepSeek Harness 桌面应用**（`DeepSeek Harness.exe`） | **只能通过 App 界面**：设置 → 插件 → 添加插件 → 粘贴绝对路径 `D:\deepseek\dsh-session-delete` → 安装 |
| `web` | 浏览器模式 `dsh web` | 命令行：`dsh plugin --profile web add link:D:/deepseek/dsh-session-delete` |

**装错 profile 的症状**：一切看起来都正常，但插件的路由一直 404、界面上什么也没多。判断当前运行的是哪个 profile，可以看 `http://127.0.0.1:<port>/dsh-market/status` 返回的 `version` 与 `installed`（它们来自该 profile 自己的 `package.json`）。

`desktop` profile 用命令行装会被明确拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

这不是权限问题而是刻意的策略——桌面 profile 由 App 用自己的包管理器 + 锁文件维护。**不要**用"往 `cordis.patch.yml` 手工加 insert 行 + 手建 junction"的方式绕过：那样能跑，但以后一旦通过 App 正式安装同一个包，就会出现两个 id 相同的 loader 条目，而 DSH 明确说这会把下次启动搞挂。用 App 界面装是唯一能长期存活（不会被后续 pnpm install 清理）的方式。

命令行路径（`web` profile）会做三件事：把 `link:` 依赖写进 `~/.dsh/profiles/web/package.json`、建立 `node_modules/dsh-session-delete` junction、并把包名加入 `dsh.profile.bundles`。两种方式**都需要重启 Harness 才会加载新的 bundle 层**（当前 profile 没开 HMR，刷新页面无效；关窗口也不算退出，托盘进程还活着，可用 `tools/restart-harness.ps1`）。

界面安装时如果提示"有 agent 正在运行"，是因为安装会改插件文件、正在跑的轮次可能中途出错——等那一轮结束再点即可。

## 卸载 / 回滚

界面安装的：在 设置 → 插件 里卸载。

命令行安装的（`web` profile）：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'C:\Users\lsy\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' `
  'C:\Users\lsy\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js' `
  plugin --profile web remove dsh-session-delete
```

如果 Harness 因此起不来，把对应 profile 的 `package.json` 里 `dsh.profile.bundles` 的 `"dsh-session-delete"` 那一行删掉即可（插件自身的 insert 行只在这个包作为 bundle 被加载时才会应用）。安装前的 profile 配置另有一份备份。

## 界面上为什么"看不到"入口（重要）

行尾操作区（`⋯` 菜单 + 所有悬停按钮，含本插件的垃圾桶）由内置 `ui-workspace` 按**一个条件**渲染：

```js
// @deepseek-ai/dsh-client-ui-workspace/lib/client.js:1634, 1640
!row.blank && <span className={time}>…时间戳…</span>
!row.blank && <span className={rowActions}> ⋯ 菜单 + row.action 条目 </span>
```

`row.blank` 指**第一条提示词还没落地的空会话**。所以刚点「新会话」、还没发消息时，那一行**不该**有任何按钮——
内置的归档/置顶同样不显示。**先发一条消息**，它就不再是 blank，悬停才会露出 `⋯` 与 🗑。

另一个坑：行尾按钮由 Chromium 的 hover 状态控制。用 `SetCursorPos` 远程挪指针往往**不触发** hover；
本仓库的 `tools/screenshot-harness.ps1` 因此改用 `mouse_event` 发真实输入事件，并且需要窗口在前台。

## 工具脚本

```powershell
# 截 Harness 窗口（可只截侧栏一小块、可先悬停某一行、可点一下）
pwsh -File tools\screenshot-harness.ps1 -Out shot.png -HoverX 200 -HoverY 283 -CropX 20 -CropY 215 -CropW 280 -CropH 145
# 完全退出并重启 Harness（关窗口杀不掉托盘进程）
pwsh -File tools\restart-harness.ps1
# 对运行中的宿主做线上校验：不带参数只跑拒绝路径；给 sessionId 则真删一个会话
node tools\live-check.mjs
node tools\live-check.mjs session-xxxxxxxx
```

> 本机默认 shell 是 **Windows PowerShell 5.1**：`.ps1` 若含中文，必须以 **UTF-8 带 BOM** 保存，否则按 ANSI
> 解析会把语法搞碎。改完脚本记得重编码一次（`restart-harness.ps1` / `screenshot-harness.ps1` 均已处理）。

## 测试

四个脚本都不需要 DSH 运行，也都不碰真实的 `~/.dsh`（除了第三个只读），全部用 Node 直接跑：

```powershell
node test/host-smoke.mjs           # 假宿主上下文驱动真实 HTTP handler：400/403/404/405/409/200
node test/path-mirror-check.mjs     # 目录推导 vs 磁盘上真实目录名（含 cwd/ID 段编码、越界转义）
node test/client-render-check.mjs   # 无浏览器跑完整交互链：菜单项→确认框→fetch→刷新列表→提示，含拒绝与降级分支
node test/client-bundle-check.mjs   # 经典脚本可编译、wrapper id == 包名、require 仅用基线模块
```

`path-mirror-check.mjs` 是这四个里最重要的一个：它把 `projectKey` / `encodeSegment` 的输出与
`$DSH_HOME/sessions` 下真实存在的目录名逐字比对，所以"删错目录"这一类失败会被测试挡住，而不是等到真删。

## 装到别的设备

插件是**每台设备、每个 profile 本地**的，不会跟着账号走。整个目录拷过去即可，但**必须在目标设备重新装一次**——
安装产生的 `link:` 依赖里记的是源目录的绝对路径，拷 `package.json` 过去是无效的（路径对不上）。

1. 把 `dsh-session-delete/` 整个目录拷到目标设备（放哪都行，之后别移动它——`link:` 指向它）
2. 在目标设备安装：
   - **桌面应用**：设置 → 插件 → 添加插件 → 粘贴该目录的绝对路径 → 安装（官方管理器会顺带激活，通常不用重启）
   - **浏览器模式 `dsh web`**：`dsh plugin --profile web add link:<该目录的绝对路径，用正斜杠>`
3. 验证：打开 `http://127.0.0.1:<port>/dsh-session-delete/status`，返回 200 即宿主半已加载；
   再悬停一个**已有消息**的会话行，看行尾有没有 🗑 和 `⋯`→「删除会话」

要拷的东西只有 `package.json` / `cordis.patch.yml` / `lib/` / `client/`（`test/`、`tools/` 是可选的）。
`tools/` 里三个脚本的路径是**写死在本机的**（Harness 安装目录、我的工作目录），换设备要么改路径要么不用它们。

## 会不会随 DSH 更新失效

分三层看，风险差别很大：

| 依赖面 | 稳定性 | 失效后的表现 |
|---|---|---|
| 打包与加载契约：`dsh.bundle.patch`、`exports["./client"]`、`__ModuleLoader__.load({id == 包名, factory})` | **稳定**（社区插件同款契约，官方文档明确） | 加载失败，侧栏不出现入口 |
| 客户端插槽：`sidebar.workspaces.session.menu.item` / `.row.action`、`ctx.slots.register` 的元数据 | **稳定**（有官方插槽名册与示例） | 插槽不再出现，或条目消失 |
| 宿主内部服务与磁盘布局：`sessionPersistence.root`/`.stat()`、`workspaceRegistry.detachSession()`、`agents.list()`、`<DSH_HOME>/sessions/<项目名>/<id>/` 与 `storages/session_projcache/…` | **内部接口，最可能变** | 最坏是"删不掉"（找不到目录→409/404），**不会删错东西** |

关于"不会删错"这一点是有意的设计：目录是由**会话头里的 cwd** + 镜像算法算出来的，并且
`resolve(dir)` 必须落在 `root` 之内才继续；目录不存在就什么都不删，响应里 `removed.logDirectory` 为 `null`。

其他几条：

- **插件不会自动更新**（DSH 明确如此），DSH 自身更新也不动你的 profile 目录，所以不会"更新后自己坏掉又自己好"
- 最坏情况是**该插件失效，应用照常启动**：`lib/index.js` 模块级只 import Node 内建模块、没有顶层 await，宿主服务缺失时全部走了可选链与 `typeof` 守卫；客户端对原语模块（`Modal`/`Toast`/`MenuItemButton`/图标）也都有降级分支
- 真要清理：把 profile `package.json` 里 `dsh.profile.bundles` 的 `"dsh-session-delete"` 删掉即可

**更新后自检（照顺序做）**：

```powershell
node test/path-mirror-check.mjs   # 先跑这个：它对照当前磁盘上的真实目录名，布局变了会立刻红
node test/host-smoke.mjs
node test/client-render-check.mjs
node test/client-bundle-check.mjs
```

`path-mirror-check.mjs` 失败 = DSH 换了会话目录布局，需要更新 `projectKey`/`encodeSegment` 的镜像；
四项都过而界面上仍没入口 = 插槽名或加载契约变了，需要更新 `client/client.js` 的注册。

