# @deepseek-ai/dsh-token-stats — Harness 整体 Token 用量看板插件

**双面插件**：
- 宿主半：汇总全部会话的 billed token 用量（未缓存输入 / 缓存读取 / 缓存写入 / 输出），
  按高峰/低谷给出预估费用，在宿主上提供页面与实时数据接口。
- 客户端半：在侧边栏底部（设置上方）注册 "Token 用量" 入口，点击打开看板：
  **Web 新标签页**，**桌面端（dsh-app://）应用内弹窗**（Electron shell 会拒绝一切
  `window.open` 且只把 http(s) 交给系统浏览器，所以桌面端必须走应用内弹窗）。

## 开发副本与发布包

本仓库是**开发副本**，包名 `@deepseek-ai/dsh-token-stats`（`private: true`，用于本机
profile 的链接安装）。对外发布的是 `@shallbay/dsh-token-stats`：`node pack.mjs [版本号]`
会把包名改写成发布名、去掉 `private`、补 `keywords` / `publishConfig`，产出 `dist/`
（`dist/` 不入库），发布流程见 [RELEASE.md](./RELEASE.md)。

从 npm 安装发布包：`dsh plugin --profile desktop add @shallbay/dsh-token-stats`
（Web 端把 `desktop` 换成 `web`）。

## 数据源（v3，事件驱动）

不再每次刷新扫描全部会话日志。主数据源是 dsh-token-meter 消费的同一条
`session/event` 事件流：用量记录按 `session:turn:step` 增量 upsert，
刷新时零扫描。

- **多版本事件都认**：0.1.x 的 `assistant/chunk`（外层 `data.chunk`）、0.2.x 的
  `assistant/message` 与 `assistant/attempt`（`data.usage`，或 `data.stream` 里
  最后一个 `usage` chunk）。
- **重试计费**：0.2.0 的 token-meter 在 `llm/retry-started` 之后把同一 turn/step 的
  下一次采样当作**新增**的一次计费，而不是替换。因此首次尝试沿用 `turn:step` 键，
  每次重试追加 `#n`（`1:1`、`1:1#2` …）；键格式与旧 rollup 兼容，合并幂等。

冷历史（不再重放的会话）只播种一次：优先从持久化 rollup 文件
（`$DSH_HOME/token-stats-rollup.json`）恢复（重启秒载），否则一次性扫描日志；
此后仅对 mtime/size 变化的文件做 stat-only 增量重解析。

**会话日志名**按 `session[.<version>].jsonl[.zstd]` 匹配，覆盖：
`session.jsonl.zstd`（0.1.x）、`session.v3.jsonl.zstd`、`session.v4.jsonl.zstd`（0.2.x）。
每个会话目录只取一个日志（优先压缩版）。

## 路由

| 路径 | 说明 |
|---|---|
| `GET /token-stats` | 看板页面（数据注入 `window.__DSH_DATA__`，每 60 秒自动轮询刷新，保留手动刷新按钮）。`?embed=1` 或位于 iframe 中时切到弹窗布局 |
| `GET /api/token-stats/refresh` | 增量同步（stat-only + 重解析变更文件）+ 读内存 store → JSON |
| `GET /api/token-stats/data` | 读内存 store → JSON（1 秒内命中缓存） |

看板页面的数据源优先级：`/api/token-stats/refresh`（插件）→ `/api/refresh`（独立 exe）→ `token-usage.json`（本地文件）。

## 看板布局

- **整页模式**（浏览器直接打开）：原有宽屏布局，最多 1500px。
- **弹窗/嵌入模式**（桌面端弹窗，或 `?embed=1` / 位于 iframe 中）：
  紧凑头部、更小的内边距、统计卡片 `grid-template-columns: repeat(auto-fit, minmax(156px, 1fr))`
  自动重排（5→4→3→2→1 列），趋势图高度 `clamp(190px, 30vh, 300px)`；
  弹窗宽度 ≥ 1180px 时"用量概览"与"使用趋势"并排，更窄时自动堆叠；
  会话表保持整行宽度并在容器内横向滚动。

## 安装

> **一键安装**：把插件目录解压后，运行其中的 `install.ps1`：
> ```powershell
> .\install.ps1                      # 装进 $env:DSH_PROFILE（桌面端即 desktop）
> .\install.ps1 -Profile web         # 装进 Web profile
> .\install.ps1 -Profile desktop     # 桌面端 profile
> .\install.ps1 -Copy                # 把插件复制进 profile（默认是指向源码目录的链接）
> ```
> 幂等，可重复运行；不需要 pnpm，也不需要指定运行时路径。

### 为什么用「bundle」而不是改 profile 的 cordis.patch.yml

新版 profile（桌面端，以及新版 Web 端）的 `package.json` 里有 `dsh.profile.bundles`：
profile 层栈由**选中的 bundle 各自的 `dsh.bundle.patch`** 拼出来。本包自带
`cordis.patch.yml` 并在 `package.json` 里声明了 `dsh.bundle.patch`，所以脚本做的是：

1. 在 profile 下建链接目录 `.dsh-token-stats-source` → 本插件源码目录；
2. 在 profile 的 `node_modules` 下建同名链接（0.2.x 的 profile 解析会回落到它）；
3. 把 `"@deepseek-ai/dsh-token-stats": "link:.dsh-token-stats-source"` 写进 `dependencies`；
4. 把包名追加进 `dsh.profile.bundles`。

**不要再手工往 `<profile>\cordis.patch.yml` 追加 `- insert:` 行**（尤其是桌面端）：
桌面端的这个文件由 App 自己读写（Settings / Plugins 一变动就整体重写），
手工追加的行会在下次重写时被丢掉。加进 `dsh.profile.bundles` 才是持久的。
老 profile（没有 `dsh.profile.bundles`）脚本会自动退回「复制 + 追加补丁行」的方式。

桌面端侧边栏 **Plugins → 添加插件** 填入本目录绝对路径也能装（宿主用 pnpm 安装并并入选中的
bundle 列表），效果与脚本一致。

## 生效方式

- **bundle 选择在 profile 加载时读取** —— 装完要**重启 App**（桌面端）或
  `Restart-Service dshweb`（Web 端）。桌面端也可以在 **Plugins 页**把
  `dsh-token-stats` 关掉再打开，让它就地热加载。
- 之后改源码（链接目录直接指向源码）同样是重启一次生效。
- 客户端半随模块图热更新；若侧边栏入口没出现，先刷新页面（Ctrl+F5）。

> 本机已装到桌面端 profile（`%USERPROFILE%\.dsh\profiles\desktop`），
> 清单备份在 profile 下的 `package.json.pre-token-stats`。

## 卸载

1. 从 profile 的 `package.json` 里删掉该依赖与 `dsh.profile.bundles` 中的该项；
2. 删除 `<profile>\node_modules\@deepseek-ai\dsh-token-stats` 链接与 `<profile>\.dsh-token-stats-source`；
3. 重启 App / 服务。
