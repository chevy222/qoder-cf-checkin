# Qoder 签到 Worker 部署与使用说明

**只有一个代码文件 `worker.js`，不需要安装 Node / npm / wrangler，在 Cloudflare 网页控制台粘贴即可。**

- 定时自动签到，查活动列表 → 有可领取才 claim，**claim 幂等、不会重复领**；
- Token 过期前 72 小时自动静默续期；遇到 401 也会即时用 refreshToken 换新；也可随时用 `/refresh` 手动强制刷新（需口令）；
- 运行日志存在 KV，浏览器打开 `/logs` 就能看，保留 30 天；日志会标注是**定时触发**还是**手动跑的**；
- 定时任务带独立心跳，首页与 `/status` 一眼看出"上次 Cron 什么时候跑的"；
- 支持多账号（录入几个就自动签几个）；
- 设备标识（Cosy-* 请求头）由本机 PowerShell 命令一次性提取，配成 Cloudflare 环境变量。

---

## 目录

1. [准备工作](#1-准备工作)
2. [第一步：创建 Worker 并粘贴代码](#2-第一步创建-worker-并粘贴代码)
3. [第二步：创建 KV 并绑定](#3-第二步创建-kv-并绑定)
4. [第三步：设置管理口令 ADMIN_TOKEN](#4-第三步设置管理口令-admin_token)
5. [第四步：提取设备标识（关键）](#5-第四步提取设备标识关键)
6. [第五步：配置设备标识环境变量](#6-第五步配置设备标识环境变量)
7. [第六步：配置定时 Cron](#7-第六步配置定时-cron)
8. [第七步：取出 Token 并录入账号](#8-第七步取出-token-并录入账号)
9. [第八步：手动试跑并查看日志](#9-第八步手动试跑并查看日志)
10. [接口一览](#10-接口一览)
11. [日常运维与常见问题](#11-日常运维与常见问题)
12. [安全说明与卸载](#12-安全说明与卸载)

---

## 1. 准备工作

- 一个 **Cloudflare 账号**（免费即可），并已开启 `workers.dev` 子域名。
- 一台**装有并登录了 Qoder 桌面端的 Windows 电脑**（用来提取设备标识和 Token；提取完就不需要了，之后全靠 Worker 云端运行）。
- 你的 Worker 访问地址，部署后形如：`https://<worker名>.<你的子域>.workers.dev`，下面统一用 `$base` 代指。
- 命令在**终端**里执行：Windows 用 **PowerShell 7+**（`pwsh`，开始菜单搜 PowerShell）。

---

## 2. 第一步：创建 Worker 并粘贴代码

1. 登录 Cloudflare 控制台，左侧进 **Workers & Pages** → **Create**（创建）→ 选 **Workers**（从 Hello World 模板开始即可）。
2. 给 Worker 起个名，例如 `qoder-checkin`，点 **Deploy / 部署**。
3. 部署后点 **Edit code / 编辑代码**，把编辑器里自带的内容**全部删掉**。
4. 用文本编辑器打开本目录的 **`worker.js`**，全选复制，整段粘贴进网页编辑器。
5. 点右上角 **Deploy / 部署**。

部署成功后，访问 `$base/` 能看到首页（已配置账号、立即签到、运行日志、可用操作），就说明代码上线了（首页不执行任何签到任务）。

---

## 3. 第二步：创建 KV 并绑定

KV 是 Cloudflare 的键值存储，用来存凭证、运行状态和日志。

1. 控制台左侧进 **Storage & Databases（存储和数据库）** → **KV** → **Create a namespace（创建命名空间）**，名字随意，例如 `QODER`，创建。
2. 回到你刚建的 Worker → **Settings（设置）** → 找到 **Bindings（绑定）** → **Add（添加）** → 选 **KV namespace**。
3. **变量名（Variable name）必须填 `KV`**（大写，代码里就认这个名字），命名空间选刚建的 `QODER`，保存。

> 变量名填错（比如小写 `kv`）会导致运行时报错，务必是大写 `KV`。

---

## 4. 第三步：设置管理口令 ADMIN_TOKEN

只有"录入/删除凭证、手动刷新 Token"的三个接口（`/add`、`/remove`、`/refresh`）需要这个口令，防止别人往你的 KV 写入或删除凭证；查看状态 `/status`、手动签到 `/run`、日志 `/logs` 都是公开的，不需要口令。

1. Worker → **Settings** → **Variables and Secrets（变量和机密）** → **Add**。
2. 类型选 **Secret（加密/机密）**，名称填 **`ADMIN_TOKEN`**，值填一串你自己的口令（建议长一点、随机一点）。
3. 保存并**重新部署一次**（部分情况下密钥需要重新部署才生效）。
4. 同一个口令后面录入凭证时会填进终端的 `$token` 变量。

---

## 5. 第四步：提取设备标识（关键）

这是**最容易踩坑、也最关键**的一步。2026-09-26 起，Qoder 服务端要求请求携带一组 `Cosy-*` 设备头才下发每日活动；缺了这些头（特别是 `Cosy-ClientType: 10`），活动列表会直接返回空。

Cloudflare Worker 运行在云端，**无法运行 Windows exe**（Qoder 客户端用 `runtime-info.exe` 生成设备标识），所以需要在装有 Qoder 客户端的 Windows 机器上**一次性提取**，再配到 Worker 的环境变量里。

### 运行以下命令提取设备标识

在装有 Qoder 桌面端的 Windows 上打开 PowerShell 7（`pwsh`），把下面整段复制进去回车。**如果 Qoder 装在非默认位置，把第二行引号里改成你的安装路径；默认安装留空即可自动查找。**

```powershell
& {
# 非默认安装路径填这里（如 "D:\Program\Qoder CN"），默认安装留空 ""
$qoderRoot = ""

# 1. 自动找 Qoder 安装目录（默认位置 / 注册表 / 正在运行的进程，三条路都试）
if (-not $qoderRoot) {
  foreach ($p in @("$env:LOCALAPPDATA\Programs\Qoder", "$env:ProgramFiles\Qoder", "${env:ProgramFiles(x86)}\Qoder")) {
    if ($p -and (Test-Path (Join-Path $p "resources\umid\runtime-info.exe"))) { $qoderRoot = $p; break }
  }
}
if (-not $qoderRoot) {
  $reg = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*","HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*","HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match "Qoder" -and $_.InstallLocation -and (Test-Path (Join-Path $_.InstallLocation "resources\umid\runtime-info.exe")) } |
    Select-Object -First 1
  if ($reg) { $qoderRoot = $reg.InstallLocation }
}
if (-not $qoderRoot) {
  $proc = Get-Process -Name "Qoder" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc) { $qoderRoot = Split-Path $proc.Path -Parent }
}
if (-not $qoderRoot) { throw "未找到 Qoder 安装目录，请在脚本第二行填写你的安装路径" }

# 2. 运行 Qoder 自带的 runtime-info.exe（只读不写，客户端自己每小时也在跑它）
$umidExe = Join-Path $qoderRoot "resources\umid\runtime-info.exe"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $umidExe; $psi.Arguments = "--account-stdin"
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
$p.StandardInput.Close() | Out-Null
$out = $p.StandardOutput.ReadToEnd()
$p.WaitForExit(40000) | Out-Null
$ri = ($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1) | ConvertFrom-Json

# 3. 读版本号和 machine-id
$cosyVersion = ""
$mf = Join-Path $qoderRoot "resources\build-manifest.json"
if (Test-Path $mf) { try { $cosyVersion = [string]((Get-Content $mf -Raw | ConvertFrom-Json).productVersion) } catch {} }
$cosyMachineId = ""
$midDir = Get-ChildItem -Path $env:APPDATA -Filter "com.qoder.app.*" -Directory -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Where-Object { Test-Path (Join-Path $_.FullName "auth.machine-id") } |
  Select-Object -First 1
if ($midDir) { $cosyMachineId = (Get-Content (Join-Path $midDir.FullName "auth.machine-id") -Raw).Trim() }
$arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM|arm64|aarch64") { "aarch64" } else { "x86_64" }

# 4. 输出结果（把下面这些值逐个填到 Cloudflare 环境变量里）
Write-Host ""
Write-Host "====== 设备标识（复制到 Cloudflare 环境变量）======" -ForegroundColor Green
Write-Host "COSY_CLIENT_TYPE      = 10"
Write-Host "COSY_MACHINE_OS       = ${arch}_windows"
Write-Host "COSY_MACHINE_HOSTNAME  = $env:COMPUTERNAME"
if ($cosyVersion)     { Write-Host "COSY_VERSION          = $cosyVersion" }
if ($cosyMachineId)   { Write-Host "COSY_MACHINE_ID       = $cosyMachineId" }
if ($ri.machineToken) { Write-Host "COSY_MACHINE_TOKEN    = $($ri.machineToken)" }
if ($ri.machineCode)  { Write-Host "COSY_MACHINE_CODE     = $($ri.machineCode)" }
if ($ri.machineType)  { Write-Host "COSY_MACHINE_TYPE     = $($ri.machineType)" }
Write-Host "==================================================" -ForegroundColor Green
}
```

命令会自动：
- 查找 Qoder 安装目录（默认位置 / 注册表 / 正在运行的进程，三条路都试）；如果装在非默认位置，在脚本第二行填写路径即可；
- 运行 Qoder 自带的 `resources\umid\runtime-info.exe --account-stdin`（客户端自己每小时也在跑它，**只读不写**）；
- 读取 `resources\build-manifest.json` 的版本号、`%APPDATA%\com.qoder.app.*\auth.machine-id`；
- 输出一张表，把值逐个填到 Cloudflare 即可。

输出的变量包括：

| 变量名 | 来源 | 说明 |
| --- | --- | --- |
| `COSY_CLIENT_TYPE` | 固定值 `10` | **缺这个活动列表直接为空** |
| `COSY_MACHINE_TOKEN` | runtime-info.exe | 设备令牌（最可能过期的那个） |
| `COSY_MACHINE_CODE` | runtime-info.exe | 设备编码 |
| `COSY_MACHINE_TYPE` | runtime-info.exe | 设备类型 |
| `COSY_MACHINE_OS` | 系统架构 | 如 `x86_64_windows` |
| `COSY_MACHINE_HOSTNAME` | 本机主机名 | |
| `COSY_MACHINE_ID` | auth.machine-id 文件 | |
| `COSY_VERSION` | build-manifest.json | 客户端版本号 |

> **设备标识的有效期是本方案唯一的不确定性。** 如果 `Cosy-MachineToken` 是长期有效的，配置一次即可一直用；如果它会过期，活动列表会突然变空，届时重新运行上面的命令提取并更新环境变量即可。详见[常见问题](#11-日常运维与常见问题)。

---

## 6. 第五步：配置设备标识环境变量

把上一步命令输出的所有变量配到 Worker 里：

1. Worker → **Settings** → **Variables and Secrets** → **Add**。
2. 逐个添加：
   - `COSY_MACHINE_TOKEN` 建议选 **Secret（加密）**；
   - 其余（`COSY_CLIENT_TYPE`、`COSY_MACHINE_CODE`、`COSY_MACHINE_TYPE`、`COSY_MACHINE_OS`、`COSY_MACHINE_HOSTNAME`、`COSY_MACHINE_ID`、`COSY_VERSION`）可选 **Variable（明文）**，不敏感。
3. 全部加完后**重新部署一次** Worker。

> 如果你用 wrangler CLI 部署，可以把上面的值写进 `wrangler.toml` 的 `[vars]` 段；但 `COSY_MACHINE_TOKEN` 仍建议用 `wrangler secret put COSY_MACHINE_TOKEN` 单独设为 secret，不要写进配置文件。

---

## 7. 第六步：配置定时 Cron

Cron 表达式按 **UTC 时间**执行，北京时间 = UTC+8（UTC 小时 = 北京小时 − 8；减到负数就加 24）。

1. Worker → **Settings** → **Triggers（触发器）** → **Cron Triggers** → **Add**。
2. 推荐每天**北京时间 10:01** 签到，表达式：
   ```
   1 2 * * *
   ```
3. 保存。

> **保存后不会立刻生效**：Cron 触发器的新增 / 修改 / 删除最多需要 **15 分钟**才传播到 Cloudflare 全网。
>
> 想立刻验证是否配通，可以**临时**把表达式改成 `*/10 * * * *`（每 10 分钟一次），保存后等 15~25 分钟，看首页「定时任务（Cron）」卡片有没有亮起来；确认通了再改回正式表达式。

**UTC 对照表（每天一次，格式 `分 时 * * *`）：**

| 想在北京时间 | UTC 时间 | 填的表达式 |
| --- | --- | --- |
| 08:00 | 00:00 | `0 0 * * *` |
| 09:00 | 01:00 | `0 1 * * *` |
| **10:01（推荐）** | 02:01 | `1 2 * * *` |
| 12:00 | 04:00 | `0 4 * * *` |
| 20:00 | 12:00 | `0 12 * * *` |

每天只跑一次即可：程序每次先查活动列表，已领取会直接收手，**不会重复领、也不会多花 claim 次数**。

---

## 8. 第七步：取出 Token 并录入账号

Qoder 没有公开的 OAuth 登录流程，所以需要手动从 Qoder 桌面端取出 `token` 和 `refreshToken`，再通过 `/add` 接口录入 Worker。

### 8.1 取出 Token

在装有 Qoder 桌面端的 Windows 上，用 [qoder_claim.py](https://github.com/sunp-1/qoder-checkin) 读取本机登录态（只读不写）：

```powershell
python -c "import qoder_claim; s=qoder_claim.read_local_session(); print('TOKEN:' + s['token']); print('REFRESH:' + s['refreshToken'])"
```

把输出的 `TOKEN:` 和 `REFRESH:` 后面的值记下来（这是你的登录凭据，**不要分享给别人、不要提交到 git**）。

> 如果没有 Python，也可以在 Qoder 客户端里抓包取 token，但用上面的命令最省事。`qoder_claim.py` 零第三方依赖，Python ≥ 3.8 即可。

### 8.2 录入到 Worker

打开 PowerShell，初始化变量（把地址和口令替换成你自己的，地址结尾不要带斜杠）：

```powershell
$base  = "https://qoder-checkin.你的子域.workers.dev"
$token = "你自己设定的管理口令"
$accessToken = "上一步取出的 token"
$refreshToken = "上一步取出的 refreshToken"
```

录入账号：

```powershell
Invoke-RestMethod -Uri "$base/add" -Method Post `
  -Headers @{ "X-Admin-Token" = $token; "Content-Type" = "application/json" } `
  -Body (@{ token = $accessToken; refreshToken = $refreshToken; nickname = "我的Qoder号" } | ConvertTo-Json)
```

成功后返回 `{"ok":true,"uid":"...","nickname":"...","expires_at_str":"..."}`。录入时 Worker 会自动用 campaigns 接口校验 token 和设备标识是否有效，401 或其他错误会直接返回原因。

要录入多个账号就重复上面的步骤（每个账号一组 token/refreshToken）。

---

## 9. 第八步：手动试跑并查看日志

1. 浏览器打开 `$base/run`，会立即执行一次签到（所有已录入账号），页面显示每个账号的结果。
2. 打开 `$base/logs` 查看运行日志（60 秒自动刷新，点「详情」展开完整日志）。
3. 打开 `$base/status` 查看每个账号的 Token 到期时间、最近运行状态、闸门状态。

如果签到成功，日志里会看到 `领取成功 +100 Credits (...)`；如果显示「今日活动未下发」，可能是活动还没到刷新时间，等下一个 Cron 即可。

---

## 10. 接口一览

| 路径 | 方法 | 权限 | 说明 |
| --- | --- | --- | --- |
| `/` | GET | 公开 | 首页（账号 / 立即签到 / 运行日志 / 可用操作，不执行任务） |
| `/run` | GET | 公开 | 立即签到（与 Cron 同逻辑，受 30 分钟间隔保护） |
| `/status` | GET | 公开 | 账号与 Token 状态（浏览器=页面，程序调用=JSON） |
| `/logs` | GET | 公开 | 最近 30 条运行日志（60 秒自动刷新，可展开详情） |
| `/add` | POST | 需 `X-Admin-Token` | 录入 / 更新账号，JSON：`{token, refreshToken, nickname?}` |
| `/remove` | POST | 需 `X-Admin-Token` | 删除账号，JSON：`{uid}`（可选 `keep_logs:true`） |
| `/refresh` | GET | 需 `X-Admin-Token` | 手动刷新所有账号 Token（强制换新） |

浏览器访问返回可视化页面；程序调用（`Accept: application/json` 或非浏览器）返回 JSON。

---

## 11. 日常运维与常见问题

### 活动列表突然变空 / 一直显示「今日活动未下发」

**首先怀疑设备标识过期。** 特别是 `Cosy-MachineToken` 如果是短期动态令牌，过期后服务端会拒绝下发活动。

排查步骤：
1. 在 Windows 上重新运行[第五步](#5-第四步提取设备标识关键)里的那段 PowerShell 命令，对比新值和旧值（特别是 `COSY_MACHINE_TOKEN`）。
2. 如果值变了，更新 Worker 的环境变量并重新部署。
3. 部署后访问 `$base/run` 验证。

如果设备标识没变但活动仍为空，可能是：活动真的结束了（脚本会安静地报「活动列表为空」）、或 Qoder 客户端升级改了接口字段。

### Token 失效 / 401

Worker 会在 Token 过期前 72 小时自动续期，遇到 401 也会即时刷新。如果刷新失败（refreshToken 也失效了），`/status` 会显示「需重新登录」，此时需要重新走[第八步](#8-第七步取出-token-并录入账号)取出新 token 并 `/add` 更新。

也可以手动触发刷新：`Invoke-RestMethod -Uri "$base/refresh" -Headers @{ "X-Admin-Token" = $token }`。

### 签到结果是「pending」（活动未下发）

正常现象——Qoder 的每日活动不是零点准时下发，可能有延迟。Worker 每天 Cron 跑一次，如果当时没下发，第二天会再试。你也可以随时手动访问 `/run` 补签（claim 幂等，已领过不会重复发）。

### Cron 没触发

首页「定时任务（Cron）」卡片如果长期为空，说明触发器没有被调度到。检查：
- Cron 表达式是否正确（UTC 时间）；
- 触发器是否绑定到了这个 Worker；
- 刚保存的触发器最多等 15 分钟生效。

### 想换签到时间

改 Cron 表达式即可，参考[第六步的对照表](#7-第六步配置定时-cron)。

---

## 12. 安全说明与卸载

- **这是第三方非官方工具**，与 Qoder 没有任何关系，也没有得到它的背书。自动化领取属于对活动接口的手动重放，**可能不符合服务条款**，是否使用请自行判断并承担后果；请只用于你自己的账号。
- Token 和 refreshToken 存在 Cloudflare KV 中（与你的 Cloudflare 账号绑定），`/status`、`/logs` 等公开页面**不会显示 Token 明文**。
- 设备标识中的 `COSY_MACHINE_TOKEN` 建议设为 Secret（加密存储）。
- 卸载：删除 Worker 和 KV Namespace 即可，不会在 Qoder 客户端留下任何东西（本工具的所有命令都是只读的）。

---

## 致谢

- 签到逻辑参考 [sunp-1/qoder-checkin](https://github.com/sunp-1/qoder-checkin)（`qoder_claim.py`）。
- Worker 架构复用 [chevy222/trae-cf-checkin](https://github.com/chevy222/trae-cf-checkin)。
