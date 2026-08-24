# @shallbay/dsh-token-stats — Harness 整体 Token 用量看板插件

[![npm version](https://img.shields.io/npm/v/@shallbay/dsh-token-stats)](https://www.npmjs.com/package/@shallbay/dsh-token-stats)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

dsh（DeepSeek Harness）的全局 Token 用量统计看板插件，由**宿主半**与**客户端半**组成：

- **宿主半**：持续汇总 Harness 中全部会话的 billed token 用量，在 dsh web 上提供看板页面与数据接口。
- **客户端半**：在 Web 侧边栏注册 "Token 用量" 入口，点击后在新标签页打开看板。

## 功能特性

- **全局用量汇总**：跨全部会话统计 billed token 用量，按未缓存输入 / 缓存读取 / 缓存写入 / 输出四类分项。
- **费用预估**：按官方人民币定价、区分高峰/低谷时段估算费用（高峰时段 01:00–04:00、06:00–10:00 UTC，低谷为高峰半价），并给出当前区间与全部会话的累计金额。
- **实时看板**：`/token-stats` 页面每 60 秒自动采集刷新，也支持手动刷新。
- **趋势与明细**：按小时/按天查看使用趋势（高峰时段标记），并按会话列出用量明细（含目录、开始时间、调用次数）。
- **增量采集**：订阅会话事件流增量累计用量（last-wins），刷新时无需全量扫描日志；历史数据只播种一次并持久化，服务重启后秒级恢复。
- **低侵入**：宿主通过 cordis patch 挂载，客户端通过侧边栏插槽注册，无构建步骤。

## 路由

| 路径 | 说明 |
|---|---|
| `GET /token-stats` | 看板页面（数据注入 `window.__DSH_DATA__`，每 60 秒自动轮询，支持手动刷新） |
| `GET /api/token-stats/refresh` | 增量同步后返回最新数据 → JSON |
| `GET /api/token-stats/data` | 读取当前数据 → JSON（1 秒内命中缓存） |

## 安装

要求：dsh web 已部署、本机可用 pnpm（`dsh plugin` 命令依赖）。

```bash
dsh plugin --profile web add @shallbay/dsh-token-stats
```

该命令会：

1. 通过 pnpm 安装本包到 profile 的依赖中；
2. 因包内声明了 `dsh.bundle.patch`，自动把包名加入 profile 的 `dsh.profile.bundles` 启用层。

随后**重启 dsh web 服务**（bundle 在启动时加载）并 **Ctrl+F5** 刷新页面：
侧边栏底部（设置上方）出现 "Token 用量" 入口，`/token-stats` 看板可访问。

## 卸载

```bash
dsh plugin --profile web remove @shallbay/dsh-token-stats
```

该命令自动从 dependencies、bundles 与 node_modules 移除本包；随后重启 dsh web 生效。

## 开发

- `lib/index.js` — 宿主半：事件订阅、用量汇总与数据接口。
- `lib/client.js` — 客户端半：侧边栏入口。
- `lib/dashboard.html` — 看板页面。

## 许可证

[MIT](LICENSE) © ShallBay
