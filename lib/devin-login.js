// Log in to Devin with a GitHub account — pure-fetch port of the VSIX
// extension's apiLogin.ts, adapted to run inside a Chrome MV3 service worker.
//
// Flow (mirrors app.devin.ai "Continue with GitHub"):
//   1) POST /api/auth1/connections            -> github client_id
//   2) local PKCE + state
//   3) GitHub OAuth: authorize -> /login -> POST /session -> (2FA) -> (consent)
//      -> 302 back to app.devin.ai/auth/callback?code=
//   4) POST /api/auth1/github/exchange         -> Devin Bearer token
//   5) POST /api/users/post-auth               -> verify + org_id/org_name
//
// GitHub requests use credentials:'include' (browser cookie jar); we clear
// github.com cookies first so the target account logs in fresh. Devin API
// requests use credentials:'omit' (they auth via code/bearer, not cookies) so
// we never disturb the account currently signed in in the browser tab.

import { findForm, otpFieldName } from "./forms.js";
import { codesForTime } from "./totp.js";

export const DEFAULT_DEVIN_URL = "https://app.devin.ai";
export const GITHUB_BASE = "https://github.com";
const FALLBACK_GITHUB_CLIENT_ID = "Iv1.fffb955bc006997f";
const GITHUB_CONNECTION_ID = "github-devin";
const OAUTH_SCOPE = "user:email";

const noop = () => {};

function stripTrailingSlash(u) {
  return u.replace(/\/+$/, "");
}

// ---- cookie handling ----
async function clearGithubCookies() {
  const domains = ["github.com", ".github.com", "www.github.com"];
  for (const domain of domains) {
    let cookies = [];
    try {
      cookies = await chrome.cookies.getAll({ domain });
    } catch {
      cookies = [];
    }
    for (const c of cookies) {
      const prefix = c.secure ? "https://" : "http://";
      const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      const url = prefix + host + c.path;
      try {
        await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId });
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- fetch helpers ----
async function ghGet(url) {
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    redirect: "follow",
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
  return { url: res.url, status: res.status, text: await res.text(), headers: res.headers };
}

async function ghPost(url, fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) body.append(k, v ?? "");
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    redirect: "follow",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return { url: res.url, status: res.status, text: await res.text(), headers: res.headers };
}

// ---- URL / state checks ----
function isDevinCallback(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("devin.ai") && u.pathname.replace(/\/+$/, "") === "/auth/callback";
  } catch {
    return false;
  }
}

function extractCode(url) {
  const code = new URL(url).searchParams.get("code") || "";
  if (!code) throw new Error(`回调 URL 里没有 code：${url}`);
  return code;
}

function isTwoFactor(url, body) {
  if (url.includes("two-factor")) return true;
  const form = findForm(body, { actionContains: "two-factor" });
  return form !== null && otpFieldName(form.inputs) !== null;
}

function looksLikeDeviceVerification(body, url) {
  const low = body.toLowerCase();
  return (
    low.includes("device verification") ||
    low.includes("verify your device") ||
    url.includes("/sessions/verified-device") ||
    low.includes("verified-device")
  );
}

function hasLoginForm(html) {
  return findForm(html, { hasField: "login" }) !== null || findForm(html, { actionContains: "/session" }) !== null;
}

function isTwoFactorCheckup(url, html) {
  return url.includes("two_factor_checkup") || /two_factor_checkup\/delay/i.test(html);
}

function httpDateTs(dateHeader) {
  if (!dateHeader) return null;
  const ms = Date.parse(dateHeader);
  return Number.isNaN(ms) ? null : ms / 1000;
}

// ---- PKCE ----
function b64url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makePkce() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(verifierBytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: b64url(digest) };
}

// ---- GitHub OAuth ----
async function fetchGithubClientId(devinUrl, log) {
  const url = stripTrailingSlash(devinUrl) + "/api/auth1/connections";
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: "",
    });
    const data = JSON.parse((await res.text()) || "{}");
    for (const conn of data.connections || []) {
      if (conn.type === "github" && conn.client_id) return String(conn.client_id);
    }
  } catch (exc) {
    log(`⚠ 取 GitHub client_id 失败（${String(exc)}），用内置默认值。`);
  }
  return FALLBACK_GITHUB_CLIENT_ID;
}

async function navigateToTotpPage(cur, log) {
  const form = findForm(cur.text, { actionContains: "two-factor" });
  if (form && otpFieldName(form.inputs)) return cur;
  log("· 2FA 默认方式非 TOTP，切到 Authenticator app …");
  const totpUrl = new URL("/sessions/two-factor", cur.url).toString();
  const totpResp = await ghGet(totpUrl);
  const totpForm = findForm(totpResp.text, { actionContains: "two-factor" });
  if (totpForm && otpFieldName(totpForm.inputs)) return totpResp;
  const appUrl = new URL("/sessions/two-factor/app", cur.url).toString();
  return await ghGet(appUrl);
}

async function submitTwoFactor(account, resp, log) {
  if (!account.totp) throw new Error("GitHub 开了 2FA 但没给 TOTP 密钥");
  let cur = await navigateToTotpPage(resp, log);
  const serverTs = httpDateTs(cur.headers.get("date"));
  const baseTs = serverTs ?? Date.now() / 1000;
  let codes;
  try {
    codes = await codesForTime(account.totp, baseTs);
  } catch (exc) {
    throw new Error(String(exc));
  }
  for (let idx = 0; idx < codes.length; idx++) {
    const form = findForm(cur.text, { actionContains: "two-factor" });
    if (!form) {
      if (cur.url.includes("two-factor")) throw new Error(`2FA 页没解析出验证码表单（落在 ${cur.url}）`);
      return cur;
    }
    const fields = { ...form.inputs };
    const otpField = otpFieldName(fields);
    if (!otpField) throw new Error(`2FA 表单里没找到验证码字段（${Object.keys(fields).join(",")}）`);
    fields[otpField] = codes[idx];
    const action = new URL(form.action || "/sessions/two-factor", cur.url).toString();
    if (idx > 0) log("→ 2FA 验证码被拒，换相邻时间窗口重试 …");
    cur = await ghPost(action, fields);
    const stillTwoFactor = cur.url.includes("two-factor") && findForm(cur.text, { actionContains: "two-factor" }) !== null;
    if (!stillTwoFactor) return cur;
  }
  throw new Error("2FA 验证码被拒（密钥不对或时间漂移？）");
}

function ghFlash(html) {
  let m = /<div[^>]*class="[^"]*flash-error[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (!m) m = /<div[^>]*id="js-flash-container"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html);
  if (!m) return "";
  return m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

async function submitGithubCredentials(account, resp, log) {
  const form = findForm(resp.text, { hasField: "login" }) || findForm(resp.text, { actionContains: "/session" });
  if (!form) throw new Error(`GitHub 登录页没解析出登录表单（落在 ${resp.url}）`);
  const fields = { ...form.inputs };
  fields["login"] = account.username;
  fields["password"] = account.password;
  const action = new URL(form.action || "/session", resp.url).toString();
  log(`· 提交账号密码到 ${action}（${Object.keys(fields).length} 个字段）…`);
  let cur = await ghPost(action, fields);
  log(`· POST /session -> ${cur.status}，落在 ${cur.url}`);
  const body = cur.text;
  const flash = ghFlash(body);
  if (flash) log(`· GitHub 提示：${flash}`);
  if (body.toLowerCase().includes("incorrect username or password")) {
    throw new Error("GitHub 账号或密码不对");
  }
  if (looksLikeDeviceVerification(body, cur.url)) {
    throw new Error("GitHub 要求设备验证（邮箱验证码），需先用浏览器在本机验证一次该账号");
  }
  if (isTwoFactor(cur.url, body) && account.totp) {
    cur = await submitTwoFactor(account, cur, log);
  }
  return cur;
}

async function skipTwoFactorCheckup(resp, log) {
  let cur = resp;
  for (let i = 0; i < 3 && isTwoFactorCheckup(cur.url, cur.text); i++) {
    const form = findForm(cur.text, { actionContains: "two_factor_checkup/delay" });
    if (!form) {
      log("⚠ GitHub 弹出 2FA 检查页，但没解析出「skip」表单。");
      return cur;
    }
    const action = new URL(form.action || "/settings/two_factor_checkup/delay", cur.url).toString();
    log("· GitHub 弹出 2FA 检查页，自动点「skip」跳过 …");
    cur = await ghPost(action, { ...form.inputs });
  }
  return cur;
}

async function githubLogin(account, authorizeUrl, log) {
  let resp = await ghGet(authorizeUrl);
  log(`· authorize GET -> ${resp.status}，落在 ${resp.url}`);
  if (isDevinCallback(resp.url)) return extractCode(resp.url);
  if (hasLoginForm(resp.text)) {
    resp = await submitGithubCredentials(account, resp, log);
  } else {
    log(`· 首个页面没有登录表单（可能已登录或页面异常）`);
  }
  resp = await skipTwoFactorCheckup(resp, log);
  if (isDevinCallback(resp.url)) return extractCode(resp.url);
  const consent = findForm(resp.text, { actionContains: "/login/oauth/authorize" });
  if (consent) {
    const fields = { ...consent.inputs };
    if ("authorize" in fields) fields["authorize"] = "1";
    const action = new URL(consent.action, resp.url).toString();
    resp = await ghPost(action, fields);
    if (isDevinCallback(resp.url)) return extractCode(resp.url);
  }
  resp = await ghGet(authorizeUrl);
  resp = await skipTwoFactorCheckup(resp, log);
  if (isDevinCallback(resp.url)) return extractCode(resp.url);
  throw new Error(`GitHub 授权完成但没拿到回调 code（停在 ${resp.url}）`);
}

// ---- Devin token exchange / verify ----
async function exchangeCode(devinUrl, code, codeVerifier, mode) {
  const url = stripTrailingSlash(devinUrl) + "/api/auth1/github/exchange";
  const payload = {
    code,
    code_verifier: codeVerifier,
    connection_id: GITHUB_CONNECTION_ID,
    mode,
    redirect_uri: stripTrailingSlash(devinUrl) + "/auth/callback",
  };
  const res = await fetch(url, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (res.status !== 200) {
    const body = text.slice(0, 200);
    if (res.status === 400 && body.toLowerCase().includes("no account found")) {
      const e = new Error(`exchange 接口返回 ${res.status}：${body}`);
      e.accountNotFound = true;
      throw e;
    }
    throw new Error(`exchange 接口返回 ${res.status}：${body}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (exc) {
    throw new Error(`exchange 返回不是 JSON：${String(exc)}`);
  }
  if (!data.token) throw new Error(`exchange 没返回 token：${JSON.stringify(data)}`);
  return data;
}

async function verifyToken(devinUrl, token, log) {
  const url = stripTrailingSlash(devinUrl) + "/api/users/post-auth";
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      credentials: "omit",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
      body: "{}",
    });
  } catch (exc) {
    log(`⚠ 验证 token 请求失败（${String(exc)}），仅凭 exchange 结果判成功。`);
    return { ok: true, orgId: "", orgName: "" };
  }
  if (res.status === 200) {
    let data = {};
    try {
      data = JSON.parse(await res.text());
    } catch {
      data = {};
    }
    return { ok: true, orgId: String(data.org_id ?? ""), orgName: String(data.org_name ?? "") };
  }
  log(`⚠ /api/users/post-auth 返回 ${res.status}，token 可能无效。`);
  return { ok: false, orgId: "", orgName: "" };
}

async function oauthAndExchange(account, devinUrl, clientId, mode, log) {
  const { verifier, challenge } = await makePkce();
  const state = "auth1-" + crypto.randomUUID();
  const authorizeUrl =
    `${GITHUB_BASE}/login/oauth/authorize?client_id=${clientId}` +
    `&redirect_uri=${devinUrl}/auth/callback&scope=${OAUTH_SCOPE}` +
    `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
  const code = await githubLogin(account, authorizeUrl, log);
  return exchangeCode(devinUrl, code, verifier, mode);
}

/**
 * Direct Devin email/password login (no GitHub). Mirrors the app's
 * "Continue with email":
 *   POST /api/auth1/password/login  { email, password }  -> Devin Bearer token
 *   POST /api/users/post-auth       -> org_id / org_name
 * account = { username (email), password }. Returns the same result shape as
 * loginDevin.
 */
export async function loginDevinPassword(account, opts = {}) {
  const log = opts.log || noop;
  const devinUrl = stripTrailingSlash(opts.devinUrl || DEFAULT_DEVIN_URL);
  const result = { success: false, token: "", userId: "", email: "", orgId: "", orgName: "", isNewUser: false, error: "" };
  try {
    log(`· 用邮箱 ${account.username} 直登 Devin …`);
    const res = await fetch(devinUrl + "/api/auth1/password/login", {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: account.username, password: account.password }),
    });
    const text = await res.text();
    if (res.status !== 200) {
      let detail = text.slice(0, 200);
      try {
        detail = JSON.parse(text).detail || detail;
      } catch {
        /* keep raw */
      }
      if (res.status === 401) throw new Error(`邮箱或密码不对（${detail}）`);
      throw new Error(`直登接口返回 ${res.status}：${detail}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (exc) {
      throw new Error(`直登返回不是 JSON：${String(exc)}`);
    }
    result.token = String(data.token ?? data.access_token ?? "");
    result.userId = String(data.user_id ?? data.userId ?? "");
    result.email = String(data.email ?? account.username);
    result.isNewUser = Boolean(data.is_new_user);
    if (!result.token) throw new Error(`直登没返回 token：${JSON.stringify(data).slice(0, 160)}`);
    const v = await verifyToken(devinUrl, result.token, log);
    result.orgId = v.orgId;
    result.orgName = v.orgName;
    result.success = true;
    log(`✔ 直登成功（user_id=${result.userId}，org=${result.orgName || "?"}）`);
    return result;
  } catch (exc) {
    result.error = String(exc && exc.message ? exc.message : exc);
    log(`✘ 直登失败：${result.error}`);
    return result;
  }
}

/**
 * Full login. account = { username, password, totp }. Returns
 * { success, token, userId, email, orgId, orgName, isNewUser, error }.
 */
export async function loginDevin(account, opts = {}) {
  const log = opts.log || noop;
  const devinUrl = stripTrailingSlash(opts.devinUrl || DEFAULT_DEVIN_URL);
  const result = {
    success: false,
    token: "",
    userId: "",
    email: "",
    orgId: "",
    orgName: "",
    isNewUser: false,
    error: "",
  };
  try {
    log(`· 清理 github.com 旧登录态 …`);
    await clearGithubCookies();
    log(`· 获取 GitHub client_id …`);
    const clientId = await fetchGithubClientId(devinUrl, log);
    log(`· 用 GitHub=${account.username} 登录 Devin …`);
    let data;
    try {
      data = await oauthAndExchange(account, devinUrl, clientId, "login", log);
    } catch (exc) {
      if (!exc || !exc.accountNotFound) throw exc;
      log("→ 该 GitHub 号在 Devin 还没账号，自动改用注册(signup)流程重试 …");
      await clearGithubCookies();
      data = await oauthAndExchange(account, devinUrl, clientId, "signup", log);
      result.isNewUser = true;
    }
    result.token = String(data.token ?? "");
    result.userId = String(data.user_id ?? "");
    result.email = String(data.email ?? "");
    result.isNewUser = result.isNewUser || Boolean(data.is_new_user);
    const v = await verifyToken(devinUrl, result.token, log);
    result.orgId = v.orgId;
    result.orgName = v.orgName;
    result.success = Boolean(result.token);
    if (result.success) {
      log(`✔ 登录成功（user_id=${result.userId}，org=${result.orgName || "?"}）`);
    }
    return result;
  } catch (exc) {
    result.error = String(exc && exc.message ? exc.message : exc);
    log(`✘ 登录失败：${result.error}`);
    return result;
  }
}
