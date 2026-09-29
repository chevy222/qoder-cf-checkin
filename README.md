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
2. [第一步：提取设备标识和 Token（关键）](#2-第一步提取设备标识和-token关键)
3. [第二步：创建 Worker（空壳）](#3-第二步创建-worker空壳)
4. [第三步：创建 KV 并绑定](#4-第三步创建-kv-并绑定)
5. [第四步：设置管理口令 ADMIN_TOKEN](#5-第四步设置管理口令-admin_token)
6. [第五步：配置设备标识环境变量](#6-第五步配置设备标识环境变量)
7. [第六步：粘贴代码并部署](#7-第六步粘贴代码并部署)
8. [第七步：配置定时 Cron](#8-第七步配置定时-cron)
9. [第八步：录入账号](#9-第八步录入账号)
10. [第九步：手动试跑并查看日志](#10-第九步手动试跑并查看日志)
11. [接口一览](#11-接口一览)
12. [日常运维与常见问题](#12-日常运维与常见问题)
13. [安全说明与卸载](#13-安全说明与卸载)

---

## 1. 准备工作

- 一个 **Cloudflare 账号**（免费即可），并已开启 `workers.dev` 子域名。
- 一台**装有并登录了 Qoder 桌面端的 Windows 电脑**（用来提取设备标识和 Token；提取完就不需要了，之后全靠 Worker 云端运行）。
- 你的 Worker 访问地址，部署后形如：`https://<worker名>.<你的子域>.workers.dev`，下面统一用 `$base` 代指。
- 命令在**终端**里执行：Windows 用 **PowerShell 7+**（`pwsh`，开始菜单搜 PowerShell）。

---

## 2. 第一步：提取设备标识和 Token（关键）

这是**最容易踩坑、也最关键**的一步。2026-09-26 起，Qoder 服务端要求请求携带一组 `Cosy-*` 设备头才下发每日活动；缺了这些头（特别是 `Cosy-ClientType: 10`），活动列表会直接返回空。

Cloudflare Worker 运行在云端，**无法运行 Windows exe**（Qoder 客户端用 `runtime-info.exe` 生成设备标识），所以需要在装有 Qoder 客户端的 Windows 机器上**一次性提取**，再配到 Worker 的环境变量里。

### 运行以下命令一次性提取设备标识和 Token

在装有 Qoder 桌面端的 Windows 上打开 PowerShell 7（`pwsh`）。

**先设置 Qoder 安装路径**（就是包含 `Qoder CN.exe` 的那个文件夹，改成你自己的路径）：

```powershell
$qoderRoot = "D:\Program\Qoder CN"
```

**把下面整段复制进去回车**（脚本会读取上面设的 `$qoderRoot`，没设会报错提示）：

```powershell
& {
if (-not $qoderRoot) { throw "请先执行 `$qoderRoot = `"你的Qoder安装目录`" 设置路径" }

# DPAPI 解密辅助（用于解 Token）
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dpapi {
    [StructLayout(LayoutKind.Sequential)] struct BLOB { public int cb; public IntPtr pb; }
    [DllImport("crypt32.dll", SetLastError=true)] static extern bool CryptUnprotectData(ref BLOB i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref BLOB o);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr m);
    public static byte[] Unprotect(byte[] data) {
        var bi = new BLOB { cb = data.Length, pb = Marshal.AllocHGlobal(data.Length) };
        Marshal.Copy(data, 0, bi.pb, data.Length);
        var bo = new BLOB();
        if (!CryptUnprotectData(ref bi, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, ref bo)) {
            Marshal.FreeHGlobal(bi.pb); throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        Marshal.FreeHGlobal(bi.pb);
        var r = new byte[bo.cb]; Marshal.Copy(bo.pb, r, 0, bo.cb); LocalFree(bo.pb); return r;
    }
}
"@

$dataDir = Join-Path $env:APPDATA "com.qodercn.app.stable"

# 1. runtime-info.exe（设备标识）
$umidExe = Join-Path $qoderRoot "resources\umid\runtime-info.exe"
if (-not (Test-Path $umidExe)) { throw "找不到 $umidExe，请检查 `$qoderRoot 是否正确" }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $umidExe; $psi.Arguments = "--account-stdin"
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)
$p.StandardInput.Close() | Out-Null
$out = $p.StandardOutput.ReadToEnd()
$p.WaitForExit(40000) | Out-Null
$ri = ($out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1) | ConvertFrom-Json

# 2. 版本号
$cosyVersion = ""
$mf = Join-Path $qoderRoot "resources\build-manifest.json"
if (Test-Path $mf) { try { $cosyVersion = [string]((Get-Content $mf -Raw | ConvertFrom-Json).productVersion) } catch {} }

# 3. machine-id
$cosyMachineId = ""
$midFile = Join-Path $dataDir "auth.machine-id"
if (Test-Path $midFile) { $cosyMachineId = (Get-Content $midFile -Raw).Trim() }

# 4. 架构
$arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM|arm64|aarch64") { "aarch64" } else { "x86_64" }

# 5. Token 解密（DPAPI + AES-256-GCM）
$sess = $null
$tokenNote = ""
$authFile = Join-Path $dataDir "auth.v1.dat"
$stateFile = Join-Path $dataDir "Local State"
if ((Test-Path $authFile) -and (Test-Path $stateFile)) {
    try {
        $raw = [IO.File]::ReadAllBytes($authFile)
        if ($raw.Length -ge 60 -and [Text.Encoding]::ASCII.GetString($raw, 0, 3) -eq "v10") {
            $st = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $ek = [Convert]::FromBase64String($st.os_crypt.encrypted_key)
            $key = [Dpapi]::Unprotect($ek[5..($ek.Length - 1)])
            $nonce = $raw[3..14]; $ct = $raw[15..($raw.Length - 17)]; $tag = $raw[($raw.Length - 16)..($raw.Length - 1)]
            $pt = New-Object byte[] $ct.Length
            $gcm = [System.Security.Cryptography.AesGcm]::new($key)
            $gcm.Decrypt($nonce, $ct, $tag, $pt)
            $sess = [Text.Encoding]::UTF8.GetString($pt) | ConvertFrom-Json
        }
    } catch { $tokenNote = "Token 解密出错：$($_.Exception.Message)" }
} else {
    $tokenNote = "找不到 $dataDir\\auth.v1.dat 或 Local State，Qoder 桌面端登录过吗？"
}

# === 输出设备标识 ===
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

# === 输出 Token ===
if ($sess -and $sess.token) {
    Write-Host ""
    Write-Host "====== 登录凭据（后面录入账号用）======" -ForegroundColor Cyan
    Write-Host "已读取：com.qodercn.app.stable（有效期至 $($sess.expiresAt)）"
    Write-Host "TOKEN:$($sess.token)"
    Write-Host "REFRESH:$($sess.refreshToken)"
    Write-Host "======================================" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "（Token 未提取到——$tokenNote）" -ForegroundColor Yellow
    Write-Host "设备标识已正常输出，不影响签到配置。" -ForegroundColor Yellow
}
}
```

命令会输出：
- **设备标识（COSY_*）**→ 第五步配到 Cloudflare 环境变量（这部分一定有）；
- **登录凭据（TOKEN / REFRESH）**→ 第八步录入账号用；解不出会提示原因，不影响设备标识。

设备标识变量说明：

| 变量名 | 来源 | 说明 |
| --- | --- | --- |
| `COSY_CLIENT_TYPE` | 固定值 `10` | **缺这个活动列表直接为空** |
| `COSY_MACHINE_TOKEN` | runtime-info.exe | 设备令牌（最可能过期的那个） |
| `COSY_MACHINE_CODE` | runtime-info.exe | 设备编码 |
| `COSY_MACHINE_TYPE` | runtime-info.exe | 设备类型 |
| `COSY_MACHINE_OS` | 系统架构 | 如 `x86_64_windows` |
| `COSY_MACHINE_HOSTNAME` | 本机主机名 | |
| `COSY_MACHINE_ID` | com.qodercn.app.stable\auth.machine-id | |
| `COSY_VERSION` | build-manifest.json | 客户端版本号 |

> **设备标识的有效期是本方案唯一的不确定性。** 如果 `Cosy-MachineToken` 是长期有效的，配置一次即可一直用；如果它会过期，活动列表会突然变空，届时重新运行上面的命令提取并更新环境变量即可。详见[常见问题](#12-日常运维与常见问题)。

---

## 3. 第二步：创建 Worker（空壳）

先建一个空 Worker，后面几步要在它上面绑 KV、设环境变量，**最后一步才粘贴代码**。

1. 登录 Cloudflare 控制台，左侧进 **Workers & Pages** → **Create（创建）**→ 选 **Workers**（从 Hello World 模板开始即可）。
2. 给 Worker 起个名，例如 `qoder-checkin`，点 **Deploy / 部署**。
3. 部署后先**不要**改代码，直接关掉编辑器，回到 Worker 概览页。

> 这一步只是建个壳，默认的 Hello World 代码不影响后续配置。

---

## 4. 第三步：创建 KV 并绑定

KV 是 Cloudflare 的键值存储，用来存凭证、运行状态和日志。

1. 控制台左侧进 **Storage & Databases（存储和数据库）** → **KV** → **Create a namespace（创建命名空间）**，名字随意，例如 `QODER`，创建。
2. 回到你刚建的 Worker → **Settings（设置）** → 找到 **Bindings（绑定）** → **Add（添加）** → 选 **KV namespace**。
3. **变量名（Variable name）必须填 `KV`**（大写，代码里就认这个名字），命名空间选刚建的 `QODER`，保存。

> 变量名填错（比如小写 `kv`）会导致运行时报错，务必是大写 `KV`。

---

## 5. 第四步：设置管理口令 ADMIN_TOKEN

只有"录入/删除凭证、手动刷新 Token"的三个接口（`/add`、`/remove`、`/refresh`）需要这个口令，防止别人往你的 KV 写入或删除凭证；查看状态 `/status`、手动签到 `/run`、日志 `/logs` 都是公开的，不需要口令。

1. Worker → **Settings** → **Variables and Secrets（变量和机密）** → **Add**。
2. 类型选 **Secret（加密/机密）**，名称填 **`ADMIN_TOKEN`**，值填一串你自己的口令（建议长一点、随机一点）。
3. 保存。

---

## 6. 第五步：配置设备标识环境变量

把第一步命令输出的所有变量配到 Worker 里：

1. Worker → **Settings** → **Variables and Secrets** → **Add**。
2. 逐个添加：
   - `COSY_MACHINE_TOKEN` 建议选 **Secret（加密）**；
   - 其余（`COSY_CLIENT_TYPE`、`COSY_MACHINE_CODE`、`COSY_MACHINE_TYPE`、`COSY_MACHINE_OS`、`COSY_MACHINE_HOSTNAME`、`COSY_MACHINE_ID`、`COSY_VERSION`）可选 **Variable（明文）**，不敏感。
3. 全部加完后保存。

> 如果你用 wrangler CLI 部署，可以把上面的值写进 `wrangler.toml` 的 `[vars]` 段；但 `COSY_MACHINE_TOKEN` 仍建议用 `wrangler secret put COSY_MACHINE_TOKEN` 单独设为 secret，不要写进配置文件。

---

## 7. 第六步：粘贴代码并部署

KV、口令、设备标识都配好了，现在把代码贴上去：

1. Worker → **Edit code / 编辑代码**，把编辑器里自带的 Hello World 内容**全部删掉**。
2. 用文本编辑器打开本目录的 **`worker.js`**，全选复制，整段粘贴进网页编辑器。
3. 点右上角 **Deploy / 部署**。

部署成功后，访问 `$base/` 能看到首页（已配置账号、立即签到、运行日志、可用操作），就说明代码上线了（首页不执行任何签到任务）。

---

## 8. 第七步：配置定时 Cron

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

## 9. 第八步：录入账号

第一步已经取出了 `TOKEN` 和 `REFRESH`，直接录入 Worker 即可。

打开 PowerShell，初始化变量（把地址和口令替换成你自己的，地址结尾不要带斜杠；token 和 refreshToken 填第一步输出的值）：

```powershell
$base  = "https://qoder-checkin.你的子域.workers.dev"
$token = "你自己设定的管理口令"
$accessToken = "第一步输出的 TOKEN"
$refreshToken = "第一步输出的 REFRESH"
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

## 10. 第九步：手动试跑并查看日志

1. 浏览器打开 `$base/run`，会立即执行一次签到（所有已录入账号），页面显示每个账号的结果。
2. 打开 `$base/logs` 查看运行日志（60 秒自动刷新，点「详情」展开完整日志）。
3. 打开 `$base/status` 查看每个账号的 Token 到期时间、最近运行状态、闸门状态。

如果签到成功，日志里会看到 `领取成功 +100 Credits (...)`；如果显示「今日活动未下发」，可能是活动还没到刷新时间，等下一个 Cron 即可。

---

## 11. 接口一览

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

## 12. 日常运维与常见问题

### 活动列表突然变空 / 一直显示「今日活动未下发」

**首先怀疑设备标识过期。** 特别是 `Cosy-MachineToken` 如果是短期动态令牌，过期后服务端会拒绝下发活动。

排查步骤：
1. 在 Windows 上重新运行[第一步](#2-第一步提取设备标识和-token关键)里的那段 PowerShell 命令，对比新值和旧值（特别是 `COSY_MACHINE_TOKEN`）。
2. 如果值变了，更新 Worker 的环境变量并重新部署。
3. 部署后访问 `$base/run` 验证。

如果设备标识没变但活动仍为空，可能是：活动真的结束了（脚本会安静地报「活动列表为空」）、或 Qoder 客户端升级改了接口字段。

### Token 失效 / 401

Worker 会在 Token 过期前 72 小时自动续期，遇到 401 也会即时刷新。如果刷新失败（refreshToken 也失效了），`/status` 会显示「需重新登录」，此时需要重新走[第一步](#2-第一步提取设备标识和-token关键)取出新 token 并 `/add` 更新。

也可以手动触发刷新：`Invoke-RestMethod -Uri "$base/refresh" -Headers @{ "X-Admin-Token" = $token }`。

### 签到结果是「pending」（活动未下发）

正常现象——Qoder 的每日活动不是零点准时下发，可能有延迟。Worker 每天 Cron 跑一次，如果当时没下发，第二天会再试。你也可以随时手动访问 `/run` 补签（claim 幂等，已领过不会重复发）。

### Cron 没触发

首页「定时任务（Cron）」卡片如果长期为空，说明触发器没有被调度到。检查：
- Cron 表达式是否正确（UTC 时间）；
- 触发器是否绑定到了这个 Worker；
- 刚保存的触发器最多等 15 分钟生效。

### 想换签到时间

改 Cron 表达式即可，参考[第七步的对照表](#8-第七步配置定时-cron)。

---

## 13. 安全说明与卸载

- **这是第三方非官方工具**，与 Qoder 没有任何关系，也没有得到它的背书。自动化领取属于对活动接口的手动重放，**可能不符合服务条款**，是否使用请自行判断并承担后果；请只用于你自己的账号。
- Token 和 refreshToken 存在 Cloudflare KV 中（与你的 Cloudflare 账号绑定），`/status`、`/logs` 等公开页面**不会显示 Token 明文**。
- 设备标识中的 `COSY_MACHINE_TOKEN` 建议设为 Secret（加密存储）。
- 卸载：删除 Worker 和 KV Namespace 即可，不会在 Qoder 客户端留下任何东西（本工具的所有命令都是只读的）。
