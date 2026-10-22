<#
.SYNOPSIS
  @shallbay/dsh-token-stats 一键安装脚本（Harness 整体 Token 用量看板插件）

.DESCRIPTION
  把插件装进某个 dsh profile。安装方式由 profile 自己决定：

  A) **Bundle 模式（桌面端与新版 Web 端，profile 的 package.json 里有
     `dsh.profile.bundles`）** —— 与 App 里「Plugins」页安装第三方插件的方式一致：
       1) 在 profile 下建一个指向本插件源码的链接目录 .dsh-token-stats-source
       2) 在 profile 的 node_modules 下建同名链接
       3) 把 `"@shallbay/dsh-token-stats": "link:.dsh-token-stats-source"` 写进 dependencies
       4) 把包名追加进 dsh.profile.bundles
     插件的加载行由**本包自带的 cordis.patch.yml**（package.json 的 dsh.bundle.patch）插入，
     不再依赖手改 profile 的 cordis.patch.yml。

     ⚠ 桌面端的 profile 补丁文件由 App 自己读写（Settings/Plugins 一变就整体重写），
       手工追加的 `- insert:` 行会在下次重写时被丢掉 —— 所以桌面端必须走 Bundle 模式。

  B) **补丁行模式（没有 bundles 列表的老 profile）** —— 复制插件包到 profile 的
     node_modules，并向 profile 的 cordis.patch.yml 追加启用行。

  两种模式都幂等，可重复运行。

.EXAMPLE
  .\install.ps1                      # 装进 $env:DSH_PROFILE（桌面端即 desktop）
  .\install.ps1 -Profile desktop
  .\install.ps1 -Profile web
  .\install.ps1 -Copy                # 把插件复制进 profile（默认是指向源码的链接）
  .\install.ps1 -Profile web -RestartService
#>
param(
  # 目标 profile 名；缺省取 $env:DSH_PROFILE，再缺省为 web
  [string]$Profile = "",
  # DSH home；缺省取 $env:DSH_HOME，再缺省为 %USERPROFILE%\.dsh
  # 注意：不要叫 $Home —— 它是 PowerShell 的只读自动变量。
  [string]$DshHome = "",
  # Bundle 模式：复制插件进 profile，而不是链接到当前源码目录
  [switch]$Copy,
  # 安装完成后重启 dshweb 服务（仅 Web 场景需要；桌面端请重启 App）
  [switch]$RestartService
)
$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }

$srcRoot = $PSScriptRoot
foreach ($required in @("package.json", "lib", "cordis.patch.yml")) {
  if (-not (Test-Path (Join-Path $srcRoot $required))) {
    throw "$required 不在脚本同级目录（$srcRoot）。请从插件包目录运行本脚本。"
  }
}
$srcPkg = Get-Content (Join-Path $srcRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $srcPkg.dsh.bundle.patch) {
  throw "package.json 缺少 dsh.bundle.patch，无法作为 bundle 安装。"
}

# ── 1) DSH_HOME 与目标 profile ─────────────────────────────────────────────
if (-not $DshHome) { $DshHome = $env:DSH_HOME }
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
if (-not $Profile) { $Profile = $env:DSH_PROFILE }
if (-not $Profile) { $Profile = "web" }
$profileDir = Join-Path $DshHome "profiles\$Profile"
$manifestPath = Join-Path $profileDir "package.json"
Write-Step "DSH_HOME = $DshHome"
Write-Step "Profile  = $Profile  ($profileDir)"
if (-not (Test-Path $manifestPath)) { throw "profile 目录不存在或未初始化：$profileDir" }

# 自我保护：源码就在 profile 里时不能清空它
$srcFull = [System.IO.Path]::GetFullPath($srcRoot).TrimEnd("\")
$profileFull = [System.IO.Path]::GetFullPath($profileDir).TrimEnd("\")
if ($srcFull -eq $profileFull) { throw "脚本源目录就是 profile 目录，请从插件包目录运行。" }

$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bundles = @($manifest.dsh.profile.bundles)
$usesBundles = $bundles.Count -gt 0
Write-Step ("安装方式 = " + $(if ($usesBundles) { "Bundle（dsh.profile.bundles）" } else { "补丁行（老 profile）" }))

function New-DirLink([string]$linkPath, [string]$targetPath) {
  if (Test-Path $linkPath) {
    $item = Get-Item $linkPath -Force
    if ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") {
      $current = $null
      try { $current = @($item.Target)[0] } catch { }
      if ($current -eq $targetPath) { Write-Ok "链接已存在且指向正确：$linkPath"; return }
      [System.IO.Directory]::Delete($linkPath)
    } else {
      Remove-Item $linkPath -Recurse -Force
    }
  } else {
    $parent = Split-Path $linkPath -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  }
  New-Item -ItemType Junction -Path $linkPath -Target $targetPath | Out-Null
  Write-Ok "链接 -> $linkPath  ==>  $targetPath"
}

if ($usesBundles) {
  # ── 2A) Bundle 模式：链接 + 清单登记 ─────────────────────────────────────
  $short = ($srcPkg.name -split "/")[-1]
  $sourceName = ".$short-source"
  $sourceDir = Join-Path $profileDir $sourceName
  $sourceInsideProfile = $srcFull.StartsWith($profileFull + "\")

  if ($sourceInsideProfile) {
    # 源码已经在 profile 里：直接用相对路径登记，不再套一层链接
    $sourceDir = $srcRoot
    $spec = "link:./" + ([System.IO.Path]::GetRelativePath($profileDir, $srcRoot) -replace "\\", "/")
    Write-Step "源码已在 profile 内：$srcRoot"
  } else {
    $spec = "link:$sourceName"
    Write-Step "源码链接目录 -> $sourceDir"
    if ($Copy) {
      if (Test-Path $sourceDir) {
        $item = Get-Item $sourceDir -Force
        if ($item.LinkType) { [System.IO.Directory]::Delete($sourceDir) } else { Remove-Item $sourceDir -Recurse -Force }
      }
      New-Item -ItemType Directory -Path $sourceDir -Force | Out-Null
      Copy-Item (Join-Path $srcRoot "package.json") (Join-Path $sourceDir "package.json") -Force
      Copy-Item (Join-Path $srcRoot "cordis.patch.yml") (Join-Path $sourceDir "cordis.patch.yml") -Force
      Copy-Item (Join-Path $srcRoot "lib") (Join-Path $sourceDir "lib") -Recurse -Force
      Write-Ok "已复制插件包（v$($srcPkg.version)）到 $sourceDir"
    } else {
      New-DirLink $sourceDir $srcFull
    }
  }

  $linkPath = Join-Path $profileDir ("node_modules\" + ($srcPkg.name -replace "/", "\"))
  New-DirLink $linkPath $sourceDir

  $backup = "$manifestPath.pre-token-stats"
  if (-not (Test-Path $backup)) { Copy-Item $manifestPath $backup -Force; Write-Ok "profile 清单备份 -> $backup" }

  $deps = @{}
  if ($manifest.dependencies) { $manifest.dependencies.PSObject.Properties | ForEach-Object { $deps[$_.Name] = $_.Value } }
  $deps[$srcPkg.name] = $spec
  $ordered = [ordered]@{}
  foreach ($key in ($deps.Keys | Sort-Object)) { $ordered[$key] = $deps[$key] }
  $manifest.dependencies = [pscustomobject]$ordered

  if ($bundles -notcontains $srcPkg.name) { $bundles += $srcPkg.name }
  $manifest.dsh.profile.bundles = @($bundles)
  $manifest | ConvertTo-Json -Depth 20 | Set-Content -Path $manifestPath -Encoding UTF8
  Write-Ok "profile 清单已更新：dependencies[$($srcPkg.name)] = $spec，bundles 已包含该包"
} else {
  # ── 2B) 补丁行模式：复制 + 追加启用行 ────────────────────────────────────
  $target = Join-Path $profileDir ("node_modules\" + ($srcPkg.name -replace "/", "\"))
  Write-Step "复制插件包 -> $target"
  if (Test-Path $target) {
    $item = Get-Item $target -Force
    if ($item.LinkType) { [System.IO.Directory]::Delete($target) } else { Remove-Item $target -Recurse -Force }
    Write-Ok "已清理旧副本"
  }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Copy-Item (Join-Path $srcRoot "package.json") (Join-Path $target "package.json") -Force
  Copy-Item (Join-Path $srcRoot "cordis.patch.yml") (Join-Path $target "cordis.patch.yml") -Force
  Copy-Item (Join-Path $srcRoot "lib") (Join-Path $target "lib") -Recurse -Force
  Write-Ok "插件包已就位（v$($srcPkg.version)）"

  $patch = Join-Path $profileDir "cordis.patch.yml"
  Write-Step "启用行 -> $patch"
  if ((Test-Path $patch) -and ((Get-Content $patch -Raw -Encoding UTF8) -match [regex]::Escape($srcPkg.name))) {
    Write-Ok "cordis.patch.yml 已包含 $($srcPkg.name)，跳过"
  } else {
    $block = @"

# ─── Token 用量看板插件：$($srcPkg.name)（宿主 + 客户端双面）───
- insert:
    - id: token-stats
      name: '$($srcPkg.name)'
"@
    Add-Content -Path $patch -Value $block -Encoding UTF8
    Write-Ok "已追加启用行"
  }
}

# ── 3) 可选重启（仅 Web 场景）─────────────────────────────────────────────
if ($RestartService) {
  $svc = Get-Service -Name "dshweb" -ErrorAction SilentlyContinue
  if ($svc) { Write-Step "重启 dshweb 服务……"; Restart-Service -Name "dshweb" -Force; Write-Ok "dshweb 已重启" }
  else { Write-Warn "未找到 dshweb 服务；桌面端请直接重启 App" }
}

# ── 4) 完成 ───────────────────────────────────────────────────────────────
Write-Step "安装完成。"
if ($usesBundles) {
  Write-Host "  · bundle 选择在 profile 加载时读取：请重启 App（桌面端）或 dshweb 服务（Web 端）。" -ForegroundColor White
  Write-Host "  · 重启后侧边栏底部出现「Token 用量」：桌面端点击即应用内弹窗，Web 端开新标签页。"
  Write-Host "  · 改了源码后同样重启一次即可（链接目录直接指向源码）。"
} else {
  Write-Host "  · 宿主半热加载生效；客户端入口未出现时刷新页面（Ctrl+F5）。" -ForegroundColor White
}
Write-Host "  · 卸载：删掉 profile 清单里的该依赖与 bundles 项、node_modules 下的链接，以及链接目录。"
