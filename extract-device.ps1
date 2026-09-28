<#
.SYNOPSIS
  提取 Qoder 桌面端的设备标识（Cosy-* 请求头），输出为 Cloudflare Worker 环境变量。

.DESCRIPTION
  2026-09-26 起，Qoder 服务端要求请求携带 Cosy-* 设备头才下发每日活动。
  Cloudflare Worker 无法运行 Windows exe，所以需要在装有 Qoder 客户端的
  Windows 机器上运行本脚本，一次性提取设备标识，然后手动配到 Cloudflare
  Worker 的环境变量（Variables and Secrets）里。

  本脚本只读不写：不修改、不复制 Qoder 客户端的任何文件。
  需要 PowerShell 7+（pwsh）。

.USAGE
  pwsh ./extract-device.ps1
  pwsh ./extract-device.ps1 -Json          # 只输出 JSON
  pwsh ./extract-device.ps1 -Wrangler      # 输出 wrangler.toml [vars] 格式
  pwsh ./extract-device.ps1 -QoderPath "D:\Program\Qoder"   # 指定安装目录

.OUTPUT
  默认输出一张表（变量名 → 值），附 JSON 和 Cloudflare 配置提示。
  把表中的值逐个填到 Cloudflare Worker → Settings → Variables and Secrets。
  注意：COSY_MACHINE_TOKEN 等建议设为 Secret（加密），其余可设为普通 Variable。
#>

param(
  [switch]$Json,
  [switch]$Wrangler,
  [string]$QoderPath = ""
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- 找 Qoder 安装目录
function Find-QoderRoots {
  $roots = @()

  if ($QoderPath) {
    if (Test-Path $QoderPath) { $roots += (Resolve-Path $QoderPath).Path }
    else { Write-Warning "指定的 QoderPath 不存在：$QoderPath" }
  }

  # 默认安装位置
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Qoder",
    "$env:ProgramFiles\Qoder",
    "${env:ProgramFiles(x86)}\Qoder"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $roots += (Resolve-Path $c).Path }
  }

  # 注册表卸载表
  try {
    $regPaths = @(
      "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
      "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
      "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($rp in $regPaths) {
      Get-ItemProperty $rp -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match "Qoder" } |
        ForEach-Object {
          if ($_.InstallLocation -and (Test-Path $_.InstallLocation)) {
            $roots += (Resolve-Path $_.InstallLocation).Path
          }
        }
    }
  } catch {}

  # 正在运行的 Qoder.exe 进程
  try {
    Get-Process -Name "Qoder" -ErrorAction SilentlyContinue | ForEach-Object {
      $dir = Split-Path $_.Path -Parent
      if ($dir -and (Test-Path $dir)) { $roots += $dir }
    }
  } catch {}

  # 去重（不区分大小写）
  $seen = @{}
  $result = @()
  foreach ($r in $roots) {
    $key = $r.ToLower()
    if (-not $seen.ContainsKey($key)) { $seen[$key] = $true; $result += $r }
  }
  return $result
}

# ---------------------------------------------------------------- 运行 runtime-info.exe
function Get-RuntimeInfo {
  param([string]$UmidExe)
  try {
    # --account-stdin 从 stdin 读账号，传空即可；输出最后一行是 JSON
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $UmidExe
    $psi.Arguments = "--account-stdin"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close() | Out-Null
    $stdout = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit(40000) | Out-Null
    $lines = $stdout -split "`r?`n" | Where-Object { $_.Trim() -ne "" }
    if ($lines.Count -gt 0) {
      return ($lines[-1] | ConvertFrom-Json)
    }
  } catch {
    Write-Warning "runtime-info.exe 执行失败：$($_.Exception.Message)"
  }
  return $null
}

# ---------------------------------------------------------------- 读 auth.machine-id
function Get-MachineId {
  $appdata = $env:APPDATA
  if (-not $appdata) { return "" }
  $dirs = Get-ChildItem -Path $appdata -Filter "com.qoder.app.*" -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  foreach ($d in $dirs) {
    $f = Join-Path $d.FullName "auth.machine-id"
    if (Test-Path $f) {
      $v = (Get-Content $f -Raw -ErrorAction SilentlyContinue).Trim()
      if ($v) { return $v }
    }
  }
  return ""
}

# ---------------------------------------------------------------- 主流程
$roots = Find-QoderRoots
if ($roots.Count -eq 0) {
  Write-Error "未找到 Qoder 客户端安装目录。请安装并登录 Qoder 桌面端，或用 -QoderPath 指定路径。"
  exit 1
}

$umidExe = $null
$qoderRoot = $null
foreach ($r in $roots) {
  $candidate = Join-Path $r "resources\umid\runtime-info.exe"
  if (Test-Path $candidate) { $umidExe = $candidate; $qoderRoot = $r; break }
}

if (-not $umidExe) {
  Write-Error "在以下目录中均未找到 resources\umid\runtime-info.exe："
  $roots | ForEach-Object { Write-Error "  $_" }
  exit 1
}

Write-Host "使用 Qoder 安装目录：$qoderRoot" -ForegroundColor Cyan
Write-Host "运行 runtime-info.exe…" -ForegroundColor Cyan

$ri = Get-RuntimeInfo -UmidExe $umidExe

# Cosy-Version：resources/build-manifest.json 的 productVersion
$cosyVersion = ""
$manifestPath = Join-Path $qoderRoot "resources\build-manifest.json"
if (Test-Path $manifestPath) {
  try {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.productVersion) { $cosyVersion = [string]$manifest.productVersion }
  } catch {}
}

# 架构
$arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM|arm64|aarch64") { "aarch64" } else { "x86_64" }
$cosyOS = "${arch}_windows"
$cosyHostname = $env:COMPUTERNAME
$cosyMachineId = Get-MachineId

# 组装
$vars = [ordered]@{
  COSY_CLIENT_TYPE     = "10"
  COSY_MACHINE_OS      = $cosyOS
  COSY_MACHINE_HOSTNAME = $cosyHostname
}
if ($cosyVersion) { $vars.COSY_VERSION = $cosyVersion }
if ($cosyMachineId) { $vars.COSY_MACHINE_ID = $cosyMachineId }
if ($ri) {
  if ($ri.machineToken) { $vars.COSY_MACHINE_TOKEN = [string]$ri.machineToken }
  if ($ri.machineCode)  { $vars.COSY_MACHINE_CODE  = [string]$ri.machineCode }
  if ($ri.machineType)  { $vars.COSY_MACHINE_TYPE  = [string]$ri.machineType }
}

# ---------------------------------------------------------------- 输出
if ($Json) {
  $vars | ConvertTo-Json -Depth 3
  exit 0
}

if ($Wrangler) {
  Write-Output "[vars]"
  foreach ($k in $vars.Keys) {
    $v = $vars[$k] -replace '"', '\"'
    Write-Output "$k = \"$v\""
  }
  Write-Output ""
  Write-Output "# COSY_MACHINE_TOKEN 建议改为 secret（不要写进 wrangler.toml）："
  Write-Output "# wrangler secret put COSY_MACHINE_TOKEN"
  exit 0
}

# 默认：表格 + JSON + 提示
Write-Host ""
Write-Host "=== 设备标识（Cloudflare Worker 环境变量）===" -ForegroundColor Green
Write-Host ""

$maxLen = ($vars.Keys | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum
foreach ($k in $vars.Keys) {
  $v = $vars[$k]
  $display = if ($k -eq "COSY_MACHINE_TOKEN" -and $v.Length -gt 16) {
    $v.Substring(0, 8) + "…" + $v.Substring($v.Length - 8)
  } else { $v }
  $pad = $k.PadRight($maxLen + 2)
  Write-Host ("  {0} = {1}" -f $pad, $display)
}

Write-Host ""
Write-Host "=== 完整 JSON（复制全部值用这个）===" -ForegroundColor Green
$vars | ConvertTo-Json -Depth 3

Write-Host ""
Write-Host "=== 配置方法 ===" -ForegroundColor Green
Write-Host "1. Cloudflare 控制台 → 你的 Worker → Settings → Variables and Secrets"
Write-Host "2. 点 Add，逐个填入上表的变量名和值"
Write-Host "   - COSY_MACHINE_TOKEN 建议选 Secret（加密存储）"
Write-Host "   - 其余可选 Variable（明文，但不敏感）"
Write-Host "3. 保存后重新部署一次 Worker"
Write-Host "4. 访问 /status 或 /run 验证活动是否正常下发"
Write-Host ""
Write-Host "注意：如果设备标识过期（活动列表突然变空），重新运行本脚本提取并更新。" -ForegroundColor Yellow
