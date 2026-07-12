// Service worker: orchestrates login, account switching, quota and sessions.

import { loginDevin, loginDevinPassword } from "./lib/devin-login.js";
import { fetchQuota, fetchBillingStatus, listSessions, deleteSession, provisionServiceKey } from "./lib/devin-api.js";
import { getAccounts, updateAccount, getSettings, saveSettings } from "./lib/store.js";

// Open the full-page dashboard when the toolbar icon is clicked (no popup).
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("dashboard.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function logTo(accountId) {
  return (line) => broadcast({ type: "log", accountId, line });
}

// GitHub rejects the login POST (HTTP 422) when it sees the Origin/Referer
// headers that the browser force-attaches to extension fetches. The original
// client sent none, so we strip them on GitHub requests during login only.
const GH_HEADER_RULE_ID = 991;

async function enableGithubHeaderRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [GH_HEADER_RULE_ID],
    addRules: [
      {
        id: GH_HEADER_RULE_ID,
        priority: 1,
        condition: {
          requestDomains: ["github.com"],
          resourceTypes: ["xmlhttprequest"],
        },
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "origin", operation: "remove" },
            { header: "referer", operation: "remove" },
          ],
        },
      },
    ],
  });
}

async function disableGithubHeaderRule() {
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [GH_HEADER_RULE_ID] })
    .catch(() => {});
}

async function handleLogin(accountId) {
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return { ok: false, error: "账号不存在" };
  const { devinUrl } = await getSettings();
  const log = logTo(accountId);
  const creds = { username: acc.username, password: acc.password, totp: acc.totp };
  let res;
  if (acc.loginMode === "devin") {
    res = await loginDevinPassword(creds, { devinUrl, log });
  } else {
    try {
      await enableGithubHeaderRule();
      res = await loginDevin(creds, { devinUrl, log });
    } finally {
      await disableGithubHeaderRule();
    }
  }
  if (!res.success) {
    return { ok: false, error: res.error || "登录失败" };
  }
  const session = {
    token: res.token,
    userId: res.userId,
    orgId: res.orgId,
    orgName: res.orgName,
    email: res.email,
    updatedAt: new Date().toISOString(),
  };
  await updateAccount(accountId, { session });
  const { quota, plan } = await refreshMeta(accountId, session, devinUrl);
  return { ok: true, session, quota, plan, isNewUser: res.isNewUser };
}

// Best-effort refresh of quota + plan for a logged-in account.
async function refreshMeta(accountId, session, devinUrl) {
  let quota = null;
  let plan = null;
  const q = await fetchQuota({ devinUrl, token: session.token, orgId: session.orgId });
  if (q.ok) {
    quota = { label: q.label, updatedAt: new Date().toISOString() };
    await updateAccount(accountId, { quota });
  }
  const b = await fetchBillingStatus({ devinUrl, token: session.token, orgId: session.orgId });
  if (b.ok) {
    plan = { slug: b.planSlug, valid: b.valid, updatedAt: new Date().toISOString() };
    await updateAccount(accountId, { plan });
  }
  return { quota, plan, expired: q.expired || b.expired };
}

// Runs in the page (MAIN world) on app.devin.ai to apply a session.
function applySessionInPage(blob) {
  try {
    // Drop the previous account's auth state (token, csrf, oauth state);
    // a leftover auth1_csrf from another account triggers a 401 -> logout.
    for (const store of [localStorage, sessionStorage]) {
      const stale = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.startsWith("auth1")) stale.push(k);
      }
      stale.forEach((k) => store.removeItem(k));
    }
    localStorage.setItem("auth1_session", blob.auth1_session);
    return "ok";
  } catch (e) {
    return "err:" + String(e);
  }
}

function buildAuthBlob(session) {
  // Confirmed against the live Devin web app bundle: it reads
  //   JSON.parse(localStorage["auth1_session"]) and requires { token, userId }.
  const auth1_session = JSON.stringify({
    token: session.token,
    userId: session.userId,
  });
  return { auth1_session, extra: {} };
}

async function getOrCreateDevinTab(origin) {
  const tabs = await chrome.tabs.query({ url: origin + "/*" });
  if (tabs.length > 0) return tabs[0];
  return await chrome.tabs.create({ url: origin + "/login", active: true });
}

// Navigate a tab and resolve only once the navigation we triggered has
// actually finished loading (a bare tabs.get can see a stale "complete").
function navigateAndWait(tabId, url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (tab) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(tab);
    };
    const onUpdated = (id, info, tab) => {
      if (id === tabId && info.status === "complete") finish(tab);
    };
    const timer = setTimeout(() => {
      chrome.tabs.get(tabId).then(finish).catch(() => finish(null));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url, active: true });
  });
}

async function handleSwitch(accountId) {
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc) return { ok: false, error: "账号不存在" };
  if (!acc.session || !acc.session.token) {
    return { ok: false, error: "该账号还没登录过，请先「登录」拿到会话。" };
  }
  const { devinUrl } = await getSettings();
  const origin = new URL(devinUrl).origin;
  const tab = await getOrCreateDevinTab(origin);
  // Land on /login first: it keeps us on the app origin without bouncing to
  // the marketing site, so we have a page to write localStorage into.
  await navigateAndWait(tab.id, origin + "/login");
  const blob = buildAuthBlob(acc.session);
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: applySessionInPage,
    args: [blob],
  });
  if (result !== "ok") {
    return { ok: false, error: "写入登录态失败：" + String(result) };
  }
  // Fresh full load of the app now reads the account we just wrote.
  await navigateAndWait(tab.id, origin + "/");
  await saveSettings({ activeId: accountId });
  return { ok: true };
}

async function handleQuota(accountId) {
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc || !acc.session) return { ok: false, error: "该账号还没登录过。" };
  const { devinUrl } = await getSettings();
  const { quota, plan, expired } = await refreshMeta(accountId, acc.session, devinUrl);
  if (quota || plan) return { ok: true, quota, plan, expired };
  return { ok: false, error: "刷新失败，会话可能已过期。", expired };
}

// Refresh quota + plan for every logged-in account. Returns per-account status.
async function handleRefreshAll() {
  const accounts = await getAccounts();
  const { devinUrl } = await getSettings();
  const results = [];
  for (const acc of accounts) {
    if (!acc.session || !acc.session.token) continue;
    const { quota, plan, expired } = await refreshMeta(acc.id, acc.session, devinUrl);
    results.push({ accountId: acc.id, ok: Boolean(quota || plan), expired });
  }
  return { ok: true, results };
}

function bareId(id) {
  return String(id || "").replace(/^devin-/i, "");
}

async function handleListSessions(accountId) {
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc || !acc.session) return { ok: false, error: "该账号还没登录过。" };
  const { devinUrl } = await getSettings();
  const r = await listSessions({ devinUrl, token: acc.session.token, orgId: acc.session.orgId, limit: 30 });
  if (!r.ok) return { ok: false, error: r.error, expired: r.expired };
  // Devin keeps deleted (terminated) sessions in the listing; hide the ones
  // this extension already deleted so they don't reappear.
  const hidden = new Set((acc.hiddenSessions || []).map(bareId));
  return { ok: true, items: r.items.filter((it) => !hidden.has(bareId(it.id))) };
}

// Get a usable service-user API key for the account, provisioning one via the
// account's web session when missing (or when force-refreshing an expired key).
async function ensureApiKey(acc, devinUrl, { force = false } = {}) {
  if (!force && acc.apiKey) return { ok: true, apiKey: acc.apiKey };
  const p = await provisionServiceKey({
    devinUrl,
    token: acc.session.token,
    orgId: acc.session.orgId,
    name: "account-switcher",
  });
  if (!p.ok) return { ok: false, error: p.error, expired: p.expired };
  await updateAccount(acc.id, { apiKey: p.apiKey, serviceUserId: p.serviceUserId });
  acc.apiKey = p.apiKey;
  return { ok: true, apiKey: p.apiKey, created: true };
}

async function handleTerminate(accountId, sessionId) {
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc || !acc.session) return { ok: false, error: "该账号还没登录过。" };
  const { devinUrl } = await getSettings();
  const key = await ensureApiKey(acc, devinUrl);
  if (!key.ok) {
    return { ok: false, error: `自动创建 API Key 失败：${key.error}`, expired: key.expired };
  }
  let r = await deleteSession({ orgId: acc.session.orgId, apiKey: key.apiKey, sessionId });
  if (r.expired) {
    const fresh = await ensureApiKey(acc, devinUrl, { force: true });
    if (fresh.ok) {
      r = await deleteSession({ orgId: acc.session.orgId, apiKey: fresh.apiKey, sessionId });
    } else {
      return { ok: false, error: `API Key 失效且重建失败：${fresh.error}`, expired: fresh.expired };
    }
  }
  if (!r.ok) return { ok: false, error: r.error, expired: r.expired };
  const hidden = (acc.hiddenSessions || []).map(bareId);
  if (!hidden.includes(bareId(sessionId))) hidden.push(bareId(sessionId));
  await updateAccount(accountId, { hiddenSessions: hidden });
  return { ok: true };
}

async function handleProvision(accountId) {
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === accountId);
  if (!acc || !acc.session) return { ok: false, error: "该账号还没登录过。" };
  const { devinUrl } = await getSettings();
  const key = await ensureApiKey(acc, devinUrl, { force: true });
  return key.ok ? { ok: true } : { ok: false, error: key.error, expired: key.expired };
}

const ROUTES = {
  login: (m) => handleLogin(m.accountId),
  switch: (m) => handleSwitch(m.accountId),
  provision: (m) => handleProvision(m.accountId),
  quota: (m) => handleQuota(m.accountId),
  refreshAll: () => handleRefreshAll(),
  listSessions: (m) => handleListSessions(m.accountId),
  terminate: (m) => handleTerminate(m.accountId, m.sessionId),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const route = ROUTES[msg && msg.type];
  if (!route) return false;
  route(msg)
    .then((res) => sendResponse(res))
    .catch((exc) => sendResponse({ ok: false, error: String(exc && exc.message ? exc.message : exc) }));
  return true; // async
});
