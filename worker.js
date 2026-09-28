/**
 * Qoder 每日 Credits 签到 —— Cloudflare Worker 单文件版（免 wrangler，控制台粘贴即用）
 * ------------------------------------------------------------------------
 * 入口：
 *   scheduled()  Cron 定时触发（控制台配置：每天一次，UTC 表达式见 README 对照表）
 *   fetch()      HTTP：
 *     /          首页（账号 / 立即签到 / 运行日志 / 可用操作，不执行任务）
 *     /run       GET 公开，手动签到（与 Cron 同逻辑，受间隔闸门保护）
 *     /status    GET 公开，账号与 Token 状态（浏览器=页面，程序调用=JSON）
 *     /logs      GET 公开，运行日志列表（60 秒自动刷新，行内可展开完整日志）
 *     /add、/remove、/refresh   仅需请求头 X-Admin-Token
 * 存储：一个 KV Namespace，绑定名必须为 KV；一个密钥 ADMIN_TOKEN（仅 /add、/remove、/refresh 用）
 * 设备标识：2026-09-26 起服务端要求 Cosy-* 设备头才下发每日活动。
 *   Worker 无法运行 Windows exe，故设备标识由本机 PowerShell 脚本一次性提取，
 *   配成 Cloudflare 环境变量（COSY_*）。若设备标识过期，活动列表会变空，需重新提取。
 * 逻辑要点：token 预刷新 + 401 即时刷新、campaigns 免费先查、claim 幂等、
 *   云端不做进程内长睡眠；无 9074 限频（Qoder claim 本身幂等），仅保留最小间隔与每日上限。
 */

// ============================================================
// 页面展示的构建版本：日期（yyyymmdd）+ 当天第几次改动
// 当天第几个改动就写几；跨天则换成当天日期、序号从 1 重新开始。
// 页脚会显示它——配合自动部署时，刷新页面看这一行变没变，就知道新版本上线没有。
// ============================================================
const BUILD_VERSION = "20260928:1";

// ============================================================
// 常量（对齐 qoder_claim.py）
// ============================================================
const DEFAULT_BASES = [          // 国际版 / 国内版，自动挑能用的那个
  "https://openapi.qoder.sh",
  "https://openapi.qoder.com.cn",
];

const REFRESH_AHEAD_SEC = 72 * 3600;   // 过期前 72h 预刷新（每天一次 Cron，提前 3 天兜住漏跑风险）
const MIN_CLAIM_INTERVAL_SEC = 30 * 60; // 检查点最小间隔 30 分钟
const MAX_DAILY_ATTEMPTS = 20;          // 每日 claim 上限

const LOCK_TTL = 90;                     // 乐观锁 TTL（秒）
const REQUEST_TIMEOUT_MS = 15000;        // 单次上游请求超时（毫秒），避免对端挂起拖死整个 Cron
const LOG_TTL = 30 * 24 * 3600;          // 日志保留 30 天
const LOG_LIST_LIMIT = 30;               // /logs 列表条数

const JSON_H = {
  "Content-Type": "application/json;charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const HTML_H = {
  "Content-Type": "text/html;charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const htmlRes = (html) => new Response(html, { headers: HTML_H });

// ============================================================
// 基础工具
// ============================================================
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CST_OFFSET = 8 * 3600 * 1000; // UTC+8

function fmtCST(ts) {
  if (!ts) return "-";
  return new Date(ts * 1000 + CST_OFFSET).toISOString().slice(0, 19).replace("T", " ");
}
function cstDay(ts) {
  return new Date(ts * 1000 + CST_OFFSET).toISOString().slice(0, 10);
}
function randHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
// 数字/字符串打码：保留首尾各 4 位、中间统一遮住。长度不足时退化。
function maskDigits(v) {
  const s = String(v == null ? "" : v);
  if (s.length > 8) return s.slice(0, 4) + "••••••••" + s.slice(-4);
  if (s.length > 4) return s.slice(0, 2) + "••••••••" + s.slice(-2);
  return s;
}
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a || ""), y = enc.encode(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
// 兜底脱敏：上游响应体可能回显请求内容，错误信息最终会写进 KV 日志，先抹掉疑似凭据
function redact(s) {
  return String(s == null ? "" : s)
    .replace(/eyJ[A-Za-z0-9_-]{10,}/g, "«jwt»")
    .replace(/(["']?(?:access_token|refresh_token|token|authorization)["']?\s*[:=]\s*["']?)([^"',\s}]{6,})/gi, "$1«redacted»");
}

// JWT 解码（不验证签名，只取 payload 里的 sub/exp）
function decodeJwt(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch { return null; }
}
function uidFromToken(token) {
  const jwt = decodeJwt(token);
  if (jwt) {
    for (const k of ["sub", "uid", "user_id", "userId", "id"]) {
      if (jwt[k]) return String(jwt[k]);
    }
  }
  return null;
}
function expFromToken(token) {
  const jwt = decodeJwt(token);
  if (jwt && jwt.exp && Number(jwt.exp) > nowSec()) return Number(jwt.exp);
  return nowSec() + 14 * 86400; // 拿不到 exp 时保守按 14 天
}
async function hashUid(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 每次运行的内存日志（同时 console.log 供控制台实时日志），结束整体落一条 KV
function makeLogger() {
  const lines = [];
  const stringify = (v) => {
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const push = (lvl, args) => {
    const msg = args.map((v) => (v && typeof v === "object" ? stringify(v) : String(v))).join(" ");
    lines.push(`[${fmtCST(nowSec())}] [${lvl}] ${msg}`);
    console.log(lvl, msg);
  };
  return {
    info: (...a) => push("INFO", a),
    warn: (...a) => push("WARN", a),
    error: (...a) => push("ERROR", a),
    text: () => lines.join("\n"),
  };
}

// ============================================================
// KV 助手
// ============================================================
const acctKey = (uid) => `acct:${uid}`;
const guardKey = (uid) => `guard:${uid}`;
const stateKey = (uid) => `state:${uid}`;
const lockKey = (uid) => `lock:${uid}`;
const CRON_KEY = "cron:last";

async function getJSON(kv, key, def) {
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : def;
  } catch { return def; }
}
async function setJSON(kv, key, val) {
  await kv.put(key, JSON.stringify(val));
}

// Qoder 无 9074 退避，guard 只保留：日期、上次尝试时间、当日尝试次数
async function loadGuard(kv, uid) {
  const today = cstDay(nowSec());
  const def = { date: today, last_attempt: null, daily_attempts: 0 };
  const g = await getJSON(kv, guardKey(uid), null);
  const merged = { ...def };
  if (g) for (const k of Object.keys(def)) if (g[k] !== undefined) merged[k] = g[k];
  if (merged.date !== today) {
    merged.date = today; merged.daily_attempts = 0;
  }
  return merged;
}

// ============================================================
// 设备标识（从 Cloudflare 环境变量读取）
// ============================================================
// 2026-09-26 起服务端要求 Cosy-* 设备头才下发每日活动。
// Cosy-ClientType=10 是关键：缺这个头 campaigns 直接返回空列表。
// 其余头由 extract-device.ps1 在本机提取后配成环境变量。
function deviceHeaders(env) {
  const h = { "Cosy-ClientType": env.COSY_CLIENT_TYPE || "10" };
  if (env.COSY_MACHINE_TOKEN) h["Cosy-MachineToken"] = env.COSY_MACHINE_TOKEN;
  if (env.COSY_MACHINE_CODE) h["Cosy-MachineCode"] = env.COSY_MACHINE_CODE;
  if (env.COSY_MACHINE_TYPE) h["Cosy-MachineType"] = env.COSY_MACHINE_TYPE;
  if (env.COSY_MACHINE_OS) h["Cosy-MachineOS"] = env.COSY_MACHINE_OS;
  if (env.COSY_MACHINE_HOSTNAME) h["Cosy-MachineHostname"] = env.COSY_MACHINE_HOSTNAME;
  if (env.COSY_MACHINE_ID) h["Cosy-MachineId"] = env.COSY_MACHINE_ID;
  if (env.COSY_VERSION) h["Cosy-Version"] = env.COSY_VERSION;
  return h;
}

// ============================================================
// Qoder API（对齐 qoder_claim.py：双端点自动探测 + 401 即时刷新）
// ============================================================
function apiBases(env) {
  return env.QODER_API_BASE ? [env.QODER_API_BASE] : DEFAULT_BASES;
}

// 通用请求：按顺序试候选端点，404/网络错误跳过，第一个有效响应即返回
async function qoderFetch(env, path, method, token, body) {
  const bases = apiBases(env);
  let last = { status: 0, body: "no base", base: null };
  for (const base of bases) {
    try {
      const headers = {
        "Accept": "application/json",
        "User-Agent": "Qoder/claim",
        "Authorization": `Bearer ${token}`,
        ...deviceHeaders(env),
      };
      if (body) headers["Content-Type"] = "application/json";
      const resp = await fetch(base + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await resp.text();
      if (resp.status === 404) { last = { status: 404, body: text, base }; continue; }
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
      return { status: resp.status, body: data, base };
    } catch (e) {
      last = { status: 0, body: String(e && e.message || e), base };
      continue;
    }
  }
  return last;
}

// 用 refreshToken 换新 access token（对齐 qoder_claim.py 的 _try_refresh）
async function refreshQoderToken(env, refreshToken) {
  if (!refreshToken) return null;
  const bases = apiBases(env);
  for (const base of bases) {
    try {
      const resp = await fetch(base + "/api/v1/deviceToken/refresh", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Qoder/claim",
          ...deviceHeaders(env),
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const tok = data.token || data.accessToken || data.access_token;
      if (tok) {
        return {
          access_token: tok,
          refresh_token: data.refreshToken || data.refresh_token || refreshToken,
        };
      }
    } catch { continue; }
  }
  return null;
}

class AuthError extends Error {}

// ============================================================
// 录入凭证（/add）：校验 token → 提取 uid → 落 KV
// ============================================================
async function provision(env, body, logger) {
  const token = String(body.token || body.access_token || "").trim();
  const refreshToken = String(body.refreshToken || body.refresh_token || "").trim();
  const nickname = String(body.nickname || "").trim();
  if (!token) throw new Error("缺少 token");
  if (!refreshToken) throw new Error("缺少 refreshToken（用于自动续期）");

  // 先用 campaigns 接口校验 token 与设备标识是否有效
  const probe = await qoderFetch(env, "/sash/api/v1/me/campaigns", "GET", token);
  if (probe.status === 401) throw new AuthError("token 无效或已过期（HTTP 401）");
  if (probe.status !== 200) throw new Error(`token 校验失败 HTTP ${probe.status}：${redact(JSON.stringify(probe.body)).slice(0, 200)}`);

  let uid = uidFromToken(token);
  if (!uid) uid = await hashUid(refreshToken);

  const now = nowSec();
  const acct = {
    uid,
    nickname: nickname || ("账号 " + uid.slice(-4)),
    access_token: token,
    refresh_token: refreshToken,
    expires_at: expFromToken(token),
    created_at: now, updated_at: now,
  };
  await setJSON(env.KV, acctKey(uid), acct);
  logger.info("凭证已录入 UID", uid, "昵称", acct.nickname, "有效期至", fmtCST(acct.expires_at));
  return { uid, nickname: acct.nickname, expires_at: acct.expires_at, expires_at_str: fmtCST(acct.expires_at) };
}

// KV 无 CAS，乐观锁尽力而为：TTL 自动回收异常残留的锁。
async function withAccountLock(kv, uid, trigger, fn) {
  if (await kv.get(lockKey(uid))) return false;
  await kv.put(lockKey(uid), JSON.stringify({ since: nowSec(), trigger }), { expirationTtl: LOCK_TTL });
  try { await fn(); return true; }
  finally { await kv.delete(lockKey(uid)).catch(() => {}); }
}

// ============================================================
// 手动刷新全部账号 Token（/refresh，需 X-Admin-Token；强制换新）
// ============================================================
async function refreshAllTokens(env) {
  const kv = env.KV;
  const { keys } = await kv.list({ prefix: "acct:" });
  const out = [];
  for (const { name } of keys) {
    const acct = await getJSON(kv, name, null);
    if (!acct || !acct.uid) continue;
    const summary = { uid: acct.uid, nickname: acct.nickname || "", refreshed: false, message: "" };
    const locked = await withAccountLock(kv, acct.uid, "refresh", async () => {
      try {
        const tok = await refreshQoderToken(env, acct.refresh_token);
        if (!tok) throw new Error("refresh 接口未返回新 token");
        const updated = { ...acct, ...tok, expires_at: expFromToken(tok.access_token), updated_at: nowSec() };
        await setJSON(kv, acctKey(acct.uid), updated);
        summary.refreshed = true;
        summary.message = `已刷新，有效期至 ${fmtCST(updated.expires_at)}`;
      } catch (e) {
        summary.message = (e instanceof AuthError ? "登录态已失效，需重新 /add 录入：" : "刷新失败：") + String((e && e.message) || e);
      }
    });
    if (!locked) summary.message = "已有运行在途，跳过（并发保护），稍后重试";
    out.push(summary);
  }
  return { ran_at: fmtCST(nowSec()), count: out.length, accounts: out };
}

// ============================================================
// 单账号一次运行（Cron / 手动共用；云端不睡眠）
// ============================================================
// 真正的签到流程。调用方须已持有该账号的锁（见 withAccountLock）
async function claimForAccount(kv, env, acct, logger) {
  const uid = acct.uid;

  // —— 1) Token 预刷新 ——
  let cred = acct;
  const remaining = (cred.expires_at || 0) - nowSec();
  if (remaining <= REFRESH_AHEAD_SEC) {
    try {
      const tok = await refreshQoderToken(env, cred.refresh_token);
      if (tok) {
        cred = { ...cred, ...tok, expires_at: expFromToken(tok.access_token), updated_at: nowSec() };
        await setJSON(kv, acctKey(uid), cred);
        logger.info("Token 已刷新，有效期至", fmtCST(cred.expires_at));
      } else if (remaining > 0) {
        logger.warn("刷新失败，沿用旧 Token");
      } else {
        throw new AuthError("Token 已过期且刷新失败");
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      if (remaining > 0) logger.warn("刷新失败，沿用旧 Token：", e.message);
      else throw new AuthError("Token 已过期且刷新失败：" + e.message);
    }
  } else {
    logger.info("Token 仍有效，剩余约", Math.floor(remaining / 3600), "小时");
  }

  // —— 2) 间隔闸门 ——
  const guard = await loadGuard(kv, uid);
  const now = nowSec();
  if (guard.last_attempt && now - guard.last_attempt < MIN_CLAIM_INTERVAL_SEC)
    return { ok: false, phase: "skipped", message: "距上次领取不足 30 分钟" };
  if ((guard.daily_attempts || 0) >= MAX_DAILY_ATTEMPTS)
    return { ok: false, phase: "skipped", message: "当日 claim 已达上限" };
  const saveGuard = () => setJSON(kv, guardKey(uid), guard);

  // —— 3) 查活动列表（免费接口）——
  logger.info("查询活动列表…");
  let res = await qoderFetch(env, "/sash/api/v1/me/campaigns", "GET", cred.access_token);

  // 401 → 即时刷新一次再重试
  if (res.status === 401) {
    logger.warn("campaigns 返回 401，尝试 refreshToken 续期…");
    const tok = await refreshQoderToken(env, cred.refresh_token);
    if (tok) {
      cred = { ...cred, ...tok, expires_at: expFromToken(tok.access_token), updated_at: nowSec() };
      await setJSON(kv, acctKey(uid), cred);
      res = await qoderFetch(env, "/sash/api/v1/me/campaigns", "GET", cred.access_token);
    }
  }
  if (res.status === 401)
    throw new AuthError("campaigns 返回 HTTP 401，登录态已失效，需重新 /add 录入");
  if (res.status !== 200 || !res.body || typeof res.body !== "object")
    return { ok: false, phase: "error", message: `活动查询失败 HTTP ${res.status}：${redact(JSON.stringify(res.body)).slice(0, 160)}` };

  const payload = res.body;
  const benefits = (payload.campaigns || []).filter((c) => c && c.actionType === "CLAIM_BENEFIT");
  const claimable = benefits.filter((c) => c.claimStatus === "CLAIMABLE");

  // —— 4) 有可领取活动 → 逐个 claim（幂等）——
  if (claimable.length) {
    guard.last_attempt = now;
    guard.daily_attempts = (guard.daily_attempts || 0) + 1;
    logger.info("发现", claimable.length, "个可领取活动，发起领取（当日第", guard.daily_attempts, "次）");
    const results = [];
    for (const c of claimable) {
      const cr = await qoderFetch(env, `/sash/api/v1/me/campaigns/${encodeURIComponent(c.campaignId)}/claim`, "POST", cred.access_token, {});
      const data = (cr.body && typeof cr.body === "object" && "data" in cr.body) ? cr.body.data : cr.body;
      const ok = cr.status === 200 && data && typeof data === "object" && data.status === "CLAIMED";
      const amount = (data && data.benefit && data.benefit.amount) || (c.benefit && c.benefit.amount) || 0;
      const replayed = !!(data && data.replayed);
      results.push({ ok, amount, replayed, key: c.campaignKey, status: cr.status });
      logger.info((ok ? "领取成功 " : "领取失败 ") + `+${amount} Credits (${c.campaignKey})` + (replayed ? " [幂等重复]" : ""));
    }
    await saveGuard();
    if (results.some((r) => !r.ok))
      return { ok: false, phase: "error", message: `${results.filter((r) => !r.ok).length}/${results.length} 个活动领取失败` };
    const total = results.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    return { ok: true, phase: "claimed", message: `签到成功，本次 +${total} Credits`, credits: total };
  }

  // —— 5) 本窗口已领取 ——
  const claimedNow = benefits.filter((c) => c.claimStatus === "CLAIMED" && (c.startAt || 0) <= now && now < (c.endAt || 0));
  if (claimedNow.length) {
    const detail = claimedNow.map((c) => `${c.campaignKey} amount=${(c.benefit || {}).amount}`).join("; ");
    logger.info("本窗口已领取：", detail);
    return { ok: true, phase: "already", message: "今日已领取：" + detail, checked_in: true };
  }

  // —— 6) 活动列表为空（活动已结束）——
  if (!payload.campaigns || !benefits.length) {
    logger.info("活动列表为空（这波活动已结束，或服务端不再对账号开放）");
    return { ok: true, phase: "already", message: "活动列表为空（活动已结束或未开放）", checked_in: true };
  }

  // —— 7) 活动存在但未到可领取时间（pending）——
  const listed = benefits.map((c) => `${c.campaignKey} status=${c.claimStatus}`).join("; ").slice(0, 200);
  logger.info("今日活动未下发：", listed);
  return { ok: false, phase: "pending", message: "今日活动未下发，等下一个 Cron：" + listed };
}

// 并发保护 + 分发
async function runAccount(env, acct, { trigger, logger }) {
  let summary = null;
  const locked = await withAccountLock(env.KV, acct.uid, trigger, async () => {
    summary = await claimForAccount(env.KV, env, acct, logger);
  });
  if (!locked) {
    logger.warn("已有运行在途，跳过（并发保护）");
    return { ok: false, phase: "skipped", message: "并发跳过" };
  }
  return summary;
}

// 遍历所有账号；每个账号结束写 state + 一条 log
async function runAll(env, trigger) {
  const kv = env.KV;
  const list = await kv.list({ prefix: "acct:" });
  const out = [];
  for (const { name } of list.keys) {
    const acct = await getJSON(kv, name, null);
    if (!acct || !acct.uid) continue;
    const logger = makeLogger();
    const summary = { uid: acct.uid, nickname: acct.nickname || "", ok: false, phase: "error", message: "" };
    try {
      Object.assign(summary, await runAccount(env, acct, { trigger, logger }));
    } catch (e) {
      if (e instanceof AuthError) {
        summary.phase = "login_required";
        summary.message = "登录态失效，需重新 /add 录入";
      } else {
        summary.phase = "error";
        summary.message = String((e && e.message) || e);
      }
      logger.error(summary.message, e && e.message);
    } finally {
      const ts = nowSec();
      const tsMs = Date.now();
      try {
        await setJSON(kv, stateKey(acct.uid), { last_run_at: ts, trigger, ...summary });
      } catch (e) {
        logger.error("state 快照写入失败：", (e && e.message) || e);
      }
      try {
        const body = `# ${acct.nickname || acct.uid}  ${fmtCST(ts)} (${trigger})\n` +
          `结果：${summary.phase}  ${summary.message}\n\n${logger.text()}\n`;
        await kv.put(`log:${tsMs}:${acct.uid}`, body, {
          expirationTtl: LOG_TTL,
          metadata: { ts, uid: acct.uid, nick: acct.nickname || "", ok: !!summary.ok, phase: summary.phase, trigger, msg: String(summary.message || "").slice(0, 80) },
        });
      } catch (e) {
        logger.error("运行日志写入失败：", (e && e.message) || e);
      }
      out.push(summary);
    }
  }
  return { ran_at: fmtCST(nowSec()), trigger, count: out.length, accounts: out };
}

// ============================================================
// 页面（与 trae / workbuddy 版同风格的统一样式）
// ============================================================
const PAGE_CSS = `
*{box-sizing:border-box;}
body{margin:0;background:#F4F3EE;color:#1A1B1C;font-family:'PingFang SC','Segoe UI','Microsoft YaHei',Arial,sans-serif;line-height:1.6;font-size:13.5px;}
.wrap{max-width:920px;margin:0 auto;padding:20px 14px 40px;}
.hd{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;}
h2{font-size:17px;margin:0;font-weight:600;}
h3{font-size:14px;margin:16px 0 6px;}
.sub{font-size:12px;color:#6B7280;}
hr{border:none;border-top:1px solid #E4E3DD;margin:12px 0;}
a{color:#2E7E96;text-decoration:none;} a:hover{text-decoration:underline;}
code{background:rgba(46,126,150,.08);border:1px solid rgba(46,126,150,.18);border-radius:4px;padding:0 4px;font-size:12px;}
.tbl-scroll{overflow-x:auto;}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E4E3DD;border-radius:12px;overflow:hidden;}
th{text-align:left;background:rgba(163,213,232,.18);font-size:12px;color:#374151;padding:8px 10px;font-weight:600;white-space:nowrap;}
td{padding:8px 10px;font-size:13px;border-top:1px solid #F0EFEA;vertical-align:top;}
.badge{display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;white-space:nowrap;}
.card{background:#fff;border:1px solid #E4E3DD;border-radius:12px;padding:12px 14px;margin:10px 0;}
.cardhd{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:4px;}
.accname{font-weight:600;font-size:14px;}
.report{font-size:13.5px;color:#1F2937;word-break:break-word;}
.meta{font-size:12px;color:#6B7280;margin-top:5px;word-break:break-word;}
pre{white-space:pre-wrap;word-break:break-all;background:#fff;border:1px solid #E4E3DD;border-radius:12px;padding:14px;font-size:12.5px;line-height:1.6;}
details{margin-top:8px;} summary{cursor:pointer;color:#6B7280;font-size:12.5px;}
.btnrow a{display:inline-block;padding:6px 14px;border:1px solid #CFDADF;background:#fff;border-radius:999px;font-size:13px;margin:0 8px 8px 0;}
.warn{border-color:rgba(234,102,104,.45);}
@media (max-width:640px){
  .tbl-scroll{overflow-x:visible;}
  .logtbl{display:block;border:none;background:transparent;}
  .logtbl thead{display:none;}
  .logtbl tbody{display:block;}
  .logtbl tr{display:block;background:#fff;border:1px solid #E4E3DD;border-radius:12px;margin:10px 0;}
  .logtbl td{display:block;border-top:none;padding:5px 14px;}
  .logtbl td + td{border-top:1px dashed #F0EFEA;}
  .logtbl td[data-label]::before{content:attr(data-label);display:inline-block;min-width:4.5em;color:#6B7280;font-size:12px;}
}
`;

function pageShell(title, inner, autoRefresh) {
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    (autoRefresh ? '<meta http-equiv="refresh" content="60">' : "") +
    "<title>" + escapeHtml(title) + "</title><style>" + PAGE_CSS + "</style></head>" +
    '<body><div class="wrap">' + inner +
    '<footer style="text-align:center;margin-top:18px;font-size:12px;color:#8A919C;">Powered by <a href="https://github.com/chevy222/qoder-cf-checkin" target="_blank" rel="noopener">Github</a><br><span style="color:#A8AEB8;">version ' + escapeHtml(BUILD_VERSION) + '</span></footer>' +
    '</div></body></html>';
}

const PHASE_LABEL = {
  claimed: ["成功", "#2F6B12", "rgba(82,196,26,.14)"],
  already: ["已领取", "#2F6B12", "rgba(82,196,26,.14)"],
  pending: ["待下发", "#8A5A12", "rgba(250,173,20,.16)"],
  skipped: ["跳过", "#5B6470", "rgba(0,0,0,.05)"],
  login_required: ["需重新登录", "#A33D3F", "rgba(234,102,104,.12)"],
  error: ["错误", "#A33D3F", "rgba(234,102,104,.12)"],
};
function badge(phase) {
  const [label, color, bg] = PHASE_LABEL[phase] || [phase || "-", "#5B6470", "rgba(0,0,0,.05)"];
  return `<span class="badge" style="color:${color};background:${bg};">${escapeHtml(label)}</span>`;
}

function triggerLabel(t) {
  if (!t) return "-";
  if (t === "cron") return "定时触发";
  if (t === "manual") return "手动 · /run";
  return String(t);
}

const acctName = (a) => a.nickname || "UID " + String(a.uid).slice(-4);

function toolbar() {
  return `<div class="btnrow" style="margin-top:4px;">` +
    `<a href="/run">▶ 立即签到</a>` +
    `<a href="/logs">运行日志</a>` +
    `<a href="/status">账号状态</a>` +
    `<a href="/">首页</a>` +
    `</div>`;
}

function cronCard(hb) {
  return hb
    ? `<div class="card"><div class="accname">定时任务（Cron）</div>` +
      `<div class="report" style="color:#2F6B12;">上次触发：${escapeHtml(fmtCST(hb.ts))}</div></div>`
    : `<div class="card warn"><div class="accname">定时任务（Cron）</div>` +
      `<div class="report" style="color:#B03A3C;">尚无触发记录</div>` +
      `<div class="meta">若面板上已配置 Cron 触发器、此卡却长期为空，说明定时任务没有被调度到（代码侧无法影响调度，需查触发器配置与域名绑定的 Worker）。</div></div>`;
}

async function renderHome(env) {
  const cronBlock = cronCard(await getJSON(env.KV, CRON_KEY, null));
  let accBlock;
  try {
    const { keys } = await env.KV.list({ prefix: "acct:" });
    const accounts = [];
    for (const { name } of keys) {
      const a = await getJSON(env.KV, name, null);
      if (a && a.uid) accounts.push(a);
    }
    if (accounts.length) {
      const lines = accounts.map((a) => {
        const nm = acctName(a);
        const left = Math.floor(((a.expires_at || 0) - nowSec()) / 86400);
        let t = escapeHtml(nm);
        if (a.expires_at) {
          if (left < 0) t += `，<span style="color:#B03A3C;">令牌已过期（${cstDay(a.expires_at)}）</span>`;
          else if (left <= 7) t += `，<span style="color:#B03A3C;">令牌剩 ${left} 天（${cstDay(a.expires_at)} 到期）</span>`;
          else t += `，令牌剩 ${left} 天（${cstDay(a.expires_at)} 到期）`;
        }
        return t;
      });
      accBlock = '<div class="card">已配置 <b>' + accounts.length + "</b> 个账号：<br>" + lines.join("<br>") + "</div>";
    } else {
      accBlock = '<div class="card">当前配置 <b>0</b> 个账号。通过 <code>/add</code>（需 <code>X-Admin-Token</code>）录入 token + refreshToken 后即可开始签到。</div>';
    }
  } catch (e) {
    accBlock = '<div class="card warn" style="color:#B03A3C;">' + escapeHtml(String(e.message || e)) + "</div>";
  }

  const rows = [
    ["<a href=\"/run\">/run</a>", "立即签到（GET，逻辑与 Cron 相同，受 30 分钟间隔保护）"],
    ["<a href=\"/status\">/status</a>", "查看账号与 Token 到期 / 最近一次运行状态"],
    ["<a href=\"/logs\">/logs</a>", "最近 " + LOG_LIST_LIMIT + " 次运行日志（60 秒自动刷新，可展开详情）"],
    ["/add", "录入 / 更新账号（POST，需 X-Admin-Token，JSON：{token, refreshToken, nickname?}）"],
    ["/refresh", "手动刷新所有账号 Token（GET，需 X-Admin-Token，强制换新）"],
    ["/remove", "删除某账号及其日志（POST，需 X-Admin-Token，JSON：{uid}）"],
  ].map(([path, desc]) =>
    "<tr><td style=\"white-space:nowrap;\">" + path + "</td><td class=\"sub\">" + desc + "</td></tr>"
  ).join("");

  const inner =
    '<div class="hd"><h2>Qoder 签到 Worker</h2><span class="sub">云端自动签到 · Token 自动续期 · 幂等可重复执行</span></div>' +
    cronBlock + accBlock + toolbar() +
    '<h3>可用操作</h3><div class="tbl-scroll"><table><tbody>' + rows + "</tbody></table></div>" +
    '<p class="sub" style="margin-top:12px;">提示：<code>/run</code>、<code>/status</code>、<code>/logs</code> 公开、浏览器可直接打开；录入/删除凭证与手动刷新 Token 的 <code>/add</code>、<code>/remove</code>、<code>/refresh</code> 需请求头 <code>X-Admin-Token</code>。设备标识（Cosy-*）配在 Cloudflare 环境变量里，若活动突然不下发请先检查设备标识是否过期。</p>';
  return htmlRes(pageShell("Qoder 签到 Worker", inner, false));
}

async function renderStatus(env) {
  const { keys } = await env.KV.list({ prefix: "acct:" });
  const hb = await getJSON(env.KV, CRON_KEY, null);
  const cards = [];
  let any = false;
  for (const { name } of keys) {
    const a = await getJSON(env.KV, name, null);
    if (!a || !a.uid) continue;
    any = true;
    const st = await getJSON(env.KV, stateKey(a.uid), {});
    const guard = await loadGuard(env.KV, a.uid);
    const nm = acctName(a);
    const left = Math.floor(((a.expires_at || 0) - nowSec()) / 86400);
    const expireMiddle = !a.expires_at ? "-"
      : (left < 0 ? `<span style="color:#B03A3C;">已过期</span>` : "剩 " + left + " 天");
    const expireTail = a.expires_at ? " · " + cstDay(a.expires_at) : "";
    const meta = [
      escapeHtml("UID " + maskDigits(a.uid)),
      "Token 到期：" + expireMiddle + escapeHtml(expireTail),
      escapeHtml("上次运行：" + (st.last_run_at ? fmtCST(st.last_run_at) + " · " + triggerLabel(st.trigger) : "暂无")),
    ];
    const now = nowSec();
    const gate = [`今日 claim ${guard.daily_attempts || 0}/${MAX_DAILY_ATTEMPTS} 次`];
    if (guard.last_attempt) {
      const wait = MIN_CLAIM_INTERVAL_SEC - (now - guard.last_attempt);
      gate.push(wait > 0 ? `距可领取还有 ${Math.ceil(wait / 60)} 分钟` : `上次领取尝试 ${fmtCST(guard.last_attempt)}`);
    }
    cards.push(`<div class="card"><div class="cardhd"><span class="accname">${escapeHtml(nm)}</span>${badge(st.phase)}</div>` +
      `<div class="report">${escapeHtml(st.message || (st.ok ? "状态正常" : "尚未运行"))}</div>` +
      `<div class="meta">${meta.join(" · ")}</div>` +
      `<div class="meta">闸门：${gate.map((s) => escapeHtml(s)).join(" · ")}</div>` +
      `<details><summary>查看原始 JSON</summary><pre>${escapeHtml(JSON.stringify({ account: { uid: a.uid, nickname: a.nickname, token_expires_at: fmtCST(a.expires_at) }, guard, state: st }, null, 2))}</pre></details></div>`);
  }
  const body = any
    ? cards.join("")
    : '<div class="card">尚未录入任何账号。通过 <code>/add</code>（需 <code>X-Admin-Token</code>）录入后此页会展示账号与 Token 状态。</div>';
  const cronBlock = cronCard(hb);
  const inner =
    '<div class="hd"><h2>Qoder 账号状态</h2><span class="sub">Token 到期 / 最近运行 · 不显示 Token 明文</span></div>' +
    toolbar() + cronBlock + body +
    '<p class="sub" style="margin-top:8px;">本页不含任何 Token；程序调用时返回 JSON。</p>';
  return htmlRes(pageShell("Qoder 账号状态", inner, false));
}

function renderRunResult(result) {
  const cards = (result.accounts || []).map((s) => {
    const nm = acctName(s);
    const meta = [];
    if (s.credits) meta.push("本次 +" + s.credits + " Credits");
    return '<div class="card"><div class="cardhd"><span class="accname">' + escapeHtml(nm) + "</span>" + badge(s.phase) + "</div>" +
      '<div class="report">' + escapeHtml(s.message || "-") + "</div>" +
      (meta.length ? '<div class="meta">' + meta.map((m) => escapeHtml(m)).join(" · ") + "</div>" : "") +
      "</div>";
  }).join("");
  const inner =
    '<div class="hd"><h2>签到执行结果</h2><span class="sub">' + escapeHtml(result.ran_at) + " · " + escapeHtml(triggerLabel(result.trigger)) + " · 共 " + result.count + " 个账号</span></div>" +
    toolbar() + cards +
    "<details><summary>查看本次完整 JSON</summary><pre>" + escapeHtml(JSON.stringify(result, null, 2)) + "</pre></details>";
  return htmlRes(pageShell("Qoder 签到结果", inner, false));
}

async function* iterateLogKeys(kv, filterUid) {
  let cursor;
  for (let i = 0; i < 10; i++) {
    const page = await kv.list({ prefix: "log:", limit: 1000, cursor });
    for (const k of page.keys) {
      const m = k.metadata || {};
      if (filterUid && String(m.uid || "") !== String(filterUid)) continue;
      yield { name: k.name, m };
    }
    if (page.list_complete) return;
    cursor = page.cursor;
  }
}

async function listLogEntries(kv, filterUid) {
  const all = [];
  for await (const e of iterateLogKeys(kv, filterUid)) all.push(e);
  all.sort((a, b) => (b.m.ts || 0) - (a.m.ts || 0));
  return all.slice(0, LOG_LIST_LIMIT);
}

async function renderLogs(env, filterUid) {
  const entries = await listLogEntries(env.KV, filterUid);
  const rowHtml = [];
  for (const k of entries) {
    const m = k.m;
    const body = (await env.KV.get(k.name)) || "";
    const trigger = m.trigger || (body.match(/\((cron|manual)\)/) || [])[1] || "";
    rowHtml.push(`<tr>
      <td data-label="时间(北京)" style="padding:8px 10px;white-space:nowrap;color:#6B7280;font-size:12px;">${escapeHtml(fmtCST(m.ts))}<br><span style="color:#8A919C;">${escapeHtml(triggerLabel(trigger))}</span></td>
      <td data-label="结果" style="padding:8px 10px;">${badge(m.phase)}</td>
      <td data-label="账号" style="padding:8px 10px;font-size:13px;">${escapeHtml(m.nick || (m.uid ? "UID " + String(m.uid).slice(-4) : "-"))}</td>
      <td data-label="说明" style="padding:8px 10px;font-size:13px;color:#374151;">${escapeHtml(m.msg || "")}</td>
      <td style="padding:8px 10px;"><details><summary style="color:#2E7E96;font-size:12px;cursor:pointer;">详情</summary>
        <pre style="margin-top:6px;max-height:320px;overflow:auto;">${escapeHtml(body)}</pre></details></td>
    </tr>`);
  }
  const rows = rowHtml.join("") ||
    `<tr><td colspan="5" class="sub" style="padding:18px 10px;">暂无运行记录，点上方「立即签到」执行一次后即可看到。</td></tr>`;
  const inner = `
    <div class="hd"><h2>Qoder 签到运行日志</h2>
    <span class="sub">最近 ${LOG_LIST_LIMIT} 条 · 每 60 秒自动刷新 · 仅保留 30 天</span></div>
    ${toolbar()}
    <hr>
    <div class="tbl-scroll"><table class="logtbl">
      <thead><tr><th>时间(北京)</th><th>结果</th><th>账号</th><th>说明</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  return htmlRes(pageShell("Qoder 签到日志", inner, true));
}

async function renderLogsJson(env, filterUid) {
  const logs = (await listLogEntries(env.KV, filterUid)).map((k) => ({
    ts: k.m.ts, uid: maskDigits(k.m.uid), nick: k.m.nick, ok: k.m.ok, phase: k.m.phase,
    trigger: k.m.trigger || null, msg: k.m.msg,
  }));
  return new Response(JSON.stringify({ count: logs.length, logs }), { headers: JSON_H });
}

// ============================================================
// HTTP 路由
// ============================================================
function requireAdmin(req, env) {
  if (!env.ADMIN_TOKEN)
    return new Response(JSON.stringify({ error: "服务端未配置 ADMIN_TOKEN 密钥" }), { status: 500, headers: JSON_H });
  const got = req.headers.get("X-Admin-Token") || "";
  if (!safeEqual(got, env.ADMIN_TOKEN)) {
    if (wantsHtml(req))
      return new Response(pageShell("未授权",
        '<div class="card warn" style="color:#B03A3C;">此接口需要管理员口令：请用 PowerShell / curl 携带请求头 <code>X-Admin-Token</code> 调用（用法见 README）。</div>', false),
        { status: 401, headers: HTML_H });
    return new Response(JSON.stringify({ error: "unauthorized：需要 X-Admin-Token 头" }), { status: 401, headers: JSON_H });
  }
  return null;
}
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
function wantsHtml(req) {
  return (req.headers.get("accept") || "").includes("text/html");
}

async function handleFetch(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (path === "/" && method === "GET") {
    if (wantsHtml(req)) return renderHome(env);
    return new Response(JSON.stringify({
      ok: true,
      report: "Qoder 签到 Worker 运行中。路径：/run（立即签到）、/status（账号状态）、/logs（运行日志）；浏览器访问为可视化页面。录入/删除凭证与手动刷新 Token 的 /add、/remove、/refresh 需请求头 X-Admin-Token。",
    }), { headers: JSON_H });
  }

  if (path === "/logs" && method === "GET") {
    const uid = url.searchParams.get("uid");
    return wantsHtml(req) ? renderLogs(env, uid) : renderLogsJson(env, uid);
  }

  if (path === "/status" && method === "GET") {
    if (wantsHtml(req)) return renderStatus(env);
    const { keys } = await env.KV.list({ prefix: "acct:" });
    const accounts = [];
    for (const { name } of keys) {
      const a = await getJSON(env.KV, name, null);
      if (!a) continue;
      const st = await getJSON(env.KV, stateKey(a.uid), {});
      const guard = await loadGuard(env.KV, a.uid);
      accounts.push({
        uid: a.uid, nickname: a.nickname,
        token_expires: fmtCST(a.expires_at), state: st, guard,
      });
    }
    return new Response(JSON.stringify({ accounts, cron_last: await getJSON(env.KV, CRON_KEY, null) }), { headers: JSON_H });
  }

  if (path === "/run" && method === "GET") {
    const result = await runAll(env, "manual");
    if (wantsHtml(req)) return renderRunResult(result);
    return new Response(JSON.stringify(result), { headers: JSON_H });
  }
  if (path === "/run" && method === "POST")
    return new Response(JSON.stringify({ error: "method not allowed：/run 请用 GET 访问" }), { status: 405, headers: JSON_H });

  // —— 录入/删除凭证、手动刷新 Token 的接口需要 X-Admin-Token ——
  if (path === "/add" || path === "/remove" || path === "/refresh") {
    const deny = requireAdmin(req, env);
    if (deny) return deny;

    if (path === "/refresh" && method === "GET") {
      const result = await refreshAllTokens(env);
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: JSON_H });
    }

    if (path === "/add" && method === "POST") {
      const logger = makeLogger();
      try {
        const result = await provision(env, await readJson(req), logger);
        return new Response(JSON.stringify({ ok: true, ...result }), { headers: JSON_H });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), { status: 400, headers: JSON_H });
      }
    }

    if (path === "/remove" && method === "POST") {
      const body = await readJson(req);
      const uid = String(body.uid || "").trim();
      if (!uid)
        return new Response(JSON.stringify({ ok: false, error: "参数 uid 不能为空（先 GET /status 查看）" }), { status: 400, headers: JSON_H });
      if (!(await env.KV.get(acctKey(uid))))
        return new Response(JSON.stringify({ ok: false, error: "没有该账号，可能已被删除" }), { status: 404, headers: JSON_H });
      await env.KV.delete(acctKey(uid));
      await env.KV.delete(guardKey(uid));
      await env.KV.delete(stateKey(uid));
      let logsDeleted = 0;
      if (!body.keep_logs) {
        for await (const k of iterateLogKeys(env.KV, uid)) {
          await env.KV.delete(k.name);
          logsDeleted++;
        }
      }
      return new Response(JSON.stringify({ ok: true, uid, deleted: ["acct", "guard", "state"], logs_deleted: logsDeleted }), { headers: JSON_H });
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: JSON_H });
  }

  if (wantsHtml(req))
    return new Response(pageShell("Not Found",
      '<div class="card">页面不存在。返回 <a href="/">首页</a>，可用路径：/run、/status、/logs。</div>', false),
      { status: 404, headers: HTML_H });
  return new Response("Not Found", { status: 404 });
}

// Cron 自身（与账号无关）的兜底留痕
async function writeCronLog(kv, { phase, ok, msg, body }) {
  const ts = nowSec(), tsMs = Date.now();
  await kv.put(`log:${tsMs}:cron`, `# CRON  ${fmtCST(ts)} (cron)\n结果：${phase}  ${msg}\n\n${body}\n`, {
    expirationTtl: LOG_TTL,
    metadata: { ts, uid: "", nick: "CRON", ok, phase, trigger: "cron", msg: String(msg).slice(0, 80) },
  });
}

export default {
  async fetch(req, env) {
    try { return await handleFetch(req, env); }
    catch (e) {
      return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers: JSON_H });
    }
  },
  async scheduled(controller, env) {
    const cronExpr = String((controller && controller.cron) || "");
    const planSec = Math.floor(Number((controller && controller.scheduledTime) || Date.now()) / 1000);
    console.log("[cron] 已触发", cronExpr, fmtCST(nowSec()));
    try {
      await setJSON(env.KV, CRON_KEY, { ts: nowSec(), cron: cronExpr, plan_at: planSec, plan_at_str: fmtCST(planSec) });
    } catch (e) {
      console.error("cron 心跳写入失败（KV 不可用？）：", (e && e.message) || e);
    }
    let result = null;
    try {
      result = await runAll(env, "cron");
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.error("cron runAll 失败：", msg);
      try {
        await writeCronLog(env.KV, { phase: "error", ok: false, msg, body: `[FATAL] 账号遍历前失败：${msg}` });
      } catch {}
      return;
    }
    if (!result || !result.count) {
      try {
        await writeCronLog(env.KV, {
          phase: "skipped", ok: true, msg: "cron 已执行，但未配置任何账号",
          body: "[WARN] 本次 Cron 已执行，但 KV 中没有 acct: 账号，无需签到。",
        });
      } catch {}
    }
  },
};
