# dsh-token-stats — Harness 整体 Token 用量看板插件

<!-- dev-only -->
> `@shallbay/dsh-token-stats` 的源码仓库。开发副本以 `@deepseek-ai` 作用域链接本机 profile
> （`private: true`），发布时由 `pack.mjs` 改写成发布包名。
<!-- /dev-only -->

**双面插件**：
- 宿主半：汇总全部会话的 billed token 用量（未缓存输入 / 缓存读取 / 缓存写入 / 输出），
  按高峰 / 低谷给出预估费用，提供看板页面与实时数据接口。
- 客户端半：在侧边栏底部（设置上方）注册「Token 用量」入口，点击打开看板：
  **Web 端新标签页**，**桌面端应用内弹窗**（Electron shell 会拒绝一切 `window.open`
  且只把 http(s) 交给系统浏览器，所以桌面端必须走应用内弹窗）。

## 安装

```powershell
# 桌面端
dsh plugin --profile desktop add @shallbay/dsh-token-stats

# Web 端
dsh plugin --profile web add @shallbay/dsh-token-stats
```

装完**必须重启一次对应 surface**（bundle 选择只在 profile 加载时读取）：

- 桌面端：完全退出并重开 App；也可以在 **Plugins 页**把 `dsh-token-stats` 关掉再打开，就地热加载。
- Web 端：`Restart-Service dshweb`。

客户端半随模块图热更新；若侧边栏入口没出现，先刷新页面（Ctrl+F5）。

> 没有 `dsh` 命令时，用桌面端 **Plugins → 添加插件** 填入包名 `@shallbay/dsh-token-stats`，
> 效果相同；或直接调用安装目录下的 `resources\runtime\cli\bin\dsh.cmd`。

### 安装指定版本

```powershell
dsh plugin --profile desktop add @shallbay/dsh-token-stats@1.2.0
```

### 查看已装版本

```powershell
dsh plugin --profile desktop why @shallbay/dsh-token-stats
npm view @shallbay/dsh-token-stats version --registry=https://registry.npmjs.org/
```

## 升级

包管理器不会自动升级已安装的版本，先 `remove` 再 `add`：

```powershell
dsh plugin --profile desktop remove @shallbay/dsh-token-stats
dsh plugin --profile desktop add    @shallbay/dsh-token-stats
```

然后重启对应 surface（桌面端重开 App，Web 端 `Restart-Service dshweb`）。
升级不会影响看板里自定义的价格（存浏览器 localStorage）。

## 卸载

```powershell
# 桌面端
dsh plugin --profile desktop remove @shallbay/dsh-token-stats

# Web 端
dsh plugin --profile web remove @shallbay/dsh-token-stats
```

重启对应 surface 后，侧边栏入口与 `/token-stats` 路由一并消失。以下数据**不会**自动删除，
需要的话手动清理：

| 数据 | 位置 |
|---|---|
| 用量汇总（宿主落盘，重启秒载） | `$DSH_HOME/token-stats-rollup.json`、`$DSH_HOME/token-stats-rollup.<profile>.json` |
| 看板自定义价格 | 浏览器 localStorage 的 `dsh-token-stats/pricing/v1` |

## 使用

侧边栏底部（设置上方）「Token 用量」：

- **Web 端**：新标签页打开 `/token-stats`。
- **桌面端**：应用内弹窗（iframe 覆盖层），Esc 关闭。
- **弹窗 / 嵌入模式**（`?embed=1` 或位于 iframe 中）：紧凑头部、更小内边距，统计卡片
  `repeat(auto-fit, minmax(156px, 1fr))` 自动重排（5→4→3→2→1 列），趋势图高度
  `clamp(190px, 30vh, 300px)`；宽度 ≥ 1180px 时「用量概览」与「使用趋势」并排。

看板每 60 秒自动轮询刷新，同时保留手动刷新按钮；价格表按「供应商 / 模型」列出三项指标
（缓存命中 / 缓存未命中 / 输出）的高峰与低谷单价，可按模型修改并本地持久化。

## 路由

| 路径 | 说明 |
|---|---|
| `GET /token-stats` | 看板页面（数据注入 `window.__DSH_DATA__`）。`?embed=1` 或位于 iframe 中时切到弹窗布局 |
| `GET /api/token-stats/refresh` | 增量同步（stat-only + 重解析变更文件）+ 读内存 store → JSON |
| `GET /api/token-stats/data` | 读内存 store → JSON（1 秒内命中缓存） |

页面的数据源优先级：`/api/token-stats/refresh`（插件）→ `/api/refresh`（独立 exe）→
`token-usage.json`（本地文件）。

## 数据源（v3，事件驱动）

不再每次刷新扫描全部会话日志。主数据源是 dsh-token-meter 消费的同一条 `session/event`
事件流：用量记录按 `session:turn:step` 增量 upsert，刷新时零扫描。

- **多版本事件都认**：0.1.x 的 `assistant/chunk`（外层 `data.chunk`）、0.2.x 的
  `assistant/message` 与 `assistant/attempt`（`data.usage`，或 `data.stream` 里最后一个
  `usage` chunk）。
- **重试计费**：0.2.0 的 token-meter 在 `llm/retry-started` 之后把同一 turn/step 的下一次
  采样当作**新增**的一次计费，而不是替换。因此首次尝试沿用 `turn:step` 键，每次重试追加
  `#n`（`1:1`、`1:1#2` …）；键格式与旧 rollup 兼容，合并幂等。

冷历史（不再重放的会话）只播种一次：优先从持久化 rollup 文件
（`$DSH_HOME/token-stats-rollup.<profile>.json`）恢复（重启秒载），否则一次性扫描日志；
此后仅对 mtime/size 变化的文件做 stat-only 增量重解析。

**会话日志名**按 `session[.<version>].jsonl[.zstd]` 匹配，覆盖 `session.jsonl.zstd`（0.1.x）、
`session.v3.jsonl.zstd`、`session.v4.jsonl.zstd`（0.2.x）；每个会话目录只取一个日志
（优先压缩版）。

## 从源码安装（开发 / 离线）

```powershell
.\install.ps1                      # 装进 $env:DSH_PROFILE（桌面端即 desktop）
.\install.ps1 -Profile web         # 装进 Web profile
.\install.ps1 -Copy                # 复制进 profile（默认是指向源码目录的链接）
```

脚本是幂等的，不需要 pnpm：它在 profile 下建 `.dsh-token-stats-source` 链接、在
`node_modules` 下建同名链接、把 `"@deepseek-ai/dsh-token-stats": "link:.dsh-token-stats-source"`
写进 `dependencies`，并把包名追加进 `dsh.profile.bundles`。

> 不要手工往 `<profile>\cordis.patch.yml` 追加 `- insert:` 行（桌面端改插件时该文件会被整体重写）。
> 加进 `dsh.profile.bundles` 才是持久的；老 profile 没有 `dsh.profile.bundles` 时脚本会退回
> 「复制 + 追加补丁行」。

源码安装的卸载：从 profile 的 `package.json` 删掉该依赖与 `dsh.profile.bundles` 中的该项，
删除 `<profile>\node_modules\@deepseek-ai\dsh-token-stats` 和 `<profile>\.dsh-token-stats-source`，再重启。

## 开发

```powershell
node pack.mjs            # 构建 dist/（按 package.json 版本）
node pack.mjs 1.2.0      # 显式指定发布版本
node deploy.mjs --profile desktop   # 把源码部署进已安装副本（改包名并校验注册 id）
```

`pack.mjs` 构建时会跑十余项发布检查（包名 / 版本 / 非 private、bundle patch 与 client
声明一致、看板为浅色且统计一行 5 个、宿主含版本化日志匹配与重试计费、profile 级 rollup
隔离等），任一失败即终止。发布流程、token 与 registry 配置见 [RELEASE.md](./RELEASE.md)。

## 常见问题

- **侧边栏没有「Token 用量」入口**：先 Ctrl+F5 刷新；再确认 profile 的 `dsh.profile.bundles`
  里有 `@shallbay/dsh-token-stats`，并重启过 App / 服务。
- **`/token-stats` 404**：插件没被加载（bundle 未选中或版本装错），看宿主日志里有没有
  `token-stats` 相关报错。
- **数字全 0**：需要至少一次带用量的事件；旧会话会在首次加载时一次性扫描日志播种。
- **费用不对**：看板价格表默认按内置单价估算，可在「价格」里按模型改成你的实际单价。

## 许可

MIT
