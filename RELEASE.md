# 发布说明（维护者）

发布物：`@shallbay/dsh-token-stats`（自 1.2.2 起本目录的开发副本与发布包同名，
构建时由 `pack.mjs` 去掉 `private` 并补上 `keywords` / `publishConfig`）。

## 一次性准备：用户级 .npmrc

编辑 `C:\Users\baijunyuan\.npmrc`，**只加两行**（保留原有的 `registry=` 不变，其它包继续走 npmmirror）：

```ini
@shallbay:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=<Automation Token>
```

- 第一行只把 `@shallbay/*` 这个 scope 指向官方源 —— 实测 `npm publish --dry-run`
  会打印 `Publishing to https://registry.npmjs.org/`（不加这行则指向 npmmirror）。
  想全局都走官方源才需要改 `registry=https://registry.npmjs.org/`，那会影响这台机器上所有 npm 安装。
- Token 等于密码：只在用户级 `.npmrc` 里（不要放进项目目录，也别提交到仓库）。
- 验证登录：`npm whoami --registry=https://registry.npmjs.org`（必须带 `--registry`，
  否则会拿 npmmirror 去问而误报未登录）。

### 为什么需要「免 OTP 的 token」

npm 的交互式二次验证会弹出浏览器的 Windows 通行密钥（WebAuthn）窗口
（「确保这是你本人 / 此请求来自 Google LLC 发布的 Chrome」）；这台机器没有蓝牙适配器、
也没有 npmjs.com 的通行密钥，所以那类窗口只能取消 —— 发布必须靠 token。

实测（2026-09-30）：界面里的 Classic token 已下线，只能建 **Granular Access Token**，
且必须同时满足两点才能免 OTP 发布：

1. **Bypass 2FA** 勾选 —— 发布前用 `npm token list --json` 确认该 token 为 `bypass_2fa: true`
   （勾了没生效、或勾在别的 token 上，发布都会报 `EOTP`）；
2. **Packages and scopes 选 `Read and write (public and stage)`** —— 只选 `stage only`
   只能先传到暂存区，还要到 npmjs.com 上确认才能发布。

npm 已提示：带 Bypass 2FA 的直发 token **将于 2027-01 移除**。届时的替代方案：
`npm publish --otp=<验证器 App 的 6 位码>`、`npm stage publish` + 网站确认，
或迁移到 Trusted Publishing（GitHub Actions 的 OIDC 临时凭据）。

发布前自检（输出里 token 是脱敏的 `npm_xxxx…yyyy`，不会泄露明文）：

```powershell
npm whoami  --registry=https://registry.npmjs.org
npm token list --json --registry=https://registry.npmjs.org   # 看 bypass_2fa 是否为 true
```

## 发布

```powershell
cd D:\work\dsh\dsh-token-stats
node pack.mjs 1.1.0                 # 版本号必须大于线上最新版
cd dist
npm pack --dry-run                  # 核对文件清单（应为 8 个文件）
npm publish --access public
npm view @shallbay/dsh-token-stats version --registry=https://registry.npmjs.org
```

版本号不可覆盖：发错只能 `npm deprecate @shallbay/dsh-token-stats@<版本> "原因"` 再发新版本。

## 校验与安装

```powershell
dsh plugin --profile web     add @shallbay/dsh-token-stats@1.1.0
dsh plugin --profile desktop add @shallbay/dsh-token-stats@1.1.0
```

已装旧版要先 `remove` 再 `add`（管理器不自动升级）；装完重启一次对应 surface。

## 构建时自动检查

`pack.mjs` 每次会验证：包名/版本/非 private、bundle patch 与 client 声明、客户端 bundle
注册的 id 与新包名一致、看板为浅色且统计一行 5 个、宿主含 v3/v4 日志匹配与重试计费、
profile 级 rollup 隔离等十余项；任一项失败即终止构建。
