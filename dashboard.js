import {
  getAccounts,
  getSettings,
  saveSettings,
  parseImportText,
  upsertImported,
  removeAccount,
} from "./lib/store.js";
import { exportSession } from "./lib/devin-export.js";

const $ = (id) => document.getElementById(id);
const gridEl = $("accountGrid");
const emptyEl = $("emptyState");
const logByAccount = {};
const busy = new Set();
let searchTerm = "";

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function timeAgo(iso) {
  if (!iso) return "";
  const t = typeof iso === "number" ? iso * (iso < 1e12 ? 1000 : 1) : new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
  return Math.floor(diff / 86400) + " 天前";
}

let toastTimer;
function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3600);
}

async function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function matchesSearch(a) {
  if (!searchTerm) return true;
  const hay = (a.username + " " + (a.session?.orgName || "")).toLowerCase();
  return hay.includes(searchTerm);
}

const CORNERS = ["tl", "tr", "bl", "br"].map((p) => `<span class="corner ${p}">+</span>`).join("");

async function render() {
  const accounts = await getAccounts();
  const { activeId } = await getSettings();

  const loggedIn = accounts.filter((a) => a.session && a.session.token);
  const totalQuota = accounts.reduce((sum, a) => {
    const v = a.quota ? parseFloat(a.quota.label) : NaN;
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);
  $("statTotal").textContent = String(accounts.length).padStart(2, "0");
  $("statLoggedIn").textContent = String(loggedIn.length).padStart(2, "0");
  $("statQuota").textContent = "$" + (Math.round(totalQuota * 100) / 100);

  if (accounts.length === 0) {
    gridEl.innerHTML = "";
    gridEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    return;
  }
  gridEl.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  const shown = accounts.filter(matchesSearch);
  gridEl.innerHTML = shown.length
    ? shown.map((a) => cardHtml(a, activeId)).join("")
    : `<div class="center-note">没有匹配「${esc(searchTerm)}」的账号</div>`;
  for (const a of shown) wireCard(a.id);
}

function planChipHtml(plan) {
  if (!plan || !plan.slug) return `<span class="chip dim">套餐未知</span>`;
  const label = String(plan.slug).toUpperCase();
  if (plan.valid === false) return `<span class="chip warn">${esc(label)} · 已结束</span>`;
  return `<span class="chip">${esc(label)}</span>`;
}

function cardHtml(a, activeId) {
  const initial = (a.username[0] || "?").toUpperCase();
  const loggedIn = a.session && a.session.token;
  const active = a.id === activeId;
  const isBusy = busy.has(a.id);
  const primaryLabel = loggedIn ? "切换到此账号" : "登录";
  const primaryAct = loggedIn ? "switch" : "login";
  const savedLog = logByAccount[a.id];

  const statusVal = loggedIn
    ? `<span class="dv ok">● 已登录</span>`
    : `<span class="dv off">○ 未登录</span>`;
  const quotaVal = a.quota ? `$${esc(a.quota.label)}` : "—";
  const keyVal = a.apiKey
    ? `<span class="dv ok">就绪</span>`
    : `<span class="dv off">未创建</span>`;

  const methodChip = `<span class="chip">${a.loginMode === "devin" ? "DEVIN 直登" : "GITHUB"}</span>`;
  const planChip = planChipHtml(a.plan);
  const orgLine = loggedIn && a.session.orgName ? esc(a.session.orgName) : "尚未登录";

  return `
  <div class="card ${active ? "active" : ""}" data-id="${a.id}">
    ${CORNERS}
    ${active ? '<span class="active-tag">Active</span>' : ""}
    <div class="card-top">
      <div class="avatar">${esc(initial)}</div>
      <div class="acc-info">
        <div class="acc-email" title="${esc(a.username)}">${esc(a.username)}</div>
        <div class="acc-chips">${methodChip}${planChip}</div>
      </div>
    </div>
    <div class="acc-org" title="${esc(orgLine)}">${orgLine}</div>
    <div class="card-stats">
      <div class="dcell">
        <div class="dl">状态</div>
        <div class="dv-wrap">${statusVal}</div>
      </div>
      <div class="dcell">
        <div class="dl">额度</div>
        <div class="dv-wrap mono">${quotaVal}</div>
      </div>
      <div class="dcell">
        <div class="dl">API Key</div>
        <div class="dv-wrap">${keyVal}</div>
      </div>
    </div>
    <button class="btn btn-primary card-primary" data-act="${primaryAct}" ${isBusy ? "disabled" : ""}>
      ${isBusy ? '<span class="spin"></span>处理中' : primaryLabel}
    </button>
    <div class="card-actions">
      <button class="btn btn-ghost" data-act="relogin" title="重新登录/刷新会话" ${isBusy ? "disabled" : ""}>刷新登录</button>
      <button class="btn btn-ghost" data-act="sessions" title="会话管理" ${!loggedIn ? "disabled" : ""}>会话管理</button>
      <button class="btn btn-ghost" data-act="remove" title="从插件移除账号">移除</button>
    </div>
    <div class="card-log ${savedLog ? "" : "hidden"}" data-log>${esc(savedLog || "")}</div>
  </div>`;
}

function wireCard(id) {
  const card = gridEl.querySelector(`.card[data-id="${id}"]`);
  if (!card) return;
  card.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => onAction(id, btn.dataset.act));
  });
}

function setLog(id, line, append = true) {
  logByAccount[id] = append && logByAccount[id] ? logByAccount[id] + "\n" + line : line;
  const card = gridEl.querySelector(`.card[data-id="${id}"] [data-log]`);
  if (card) {
    card.classList.remove("hidden");
    card.textContent = logByAccount[id];
    card.scrollTop = card.scrollHeight;
  }
}

async function onAction(id, act) {
  if (act === "remove") return doRemove(id);
  if (act === "sessions") return openSessions(id);
  if (act === "switch") return doSwitch(id);
  if (act === "login" || act === "relogin") return doLogin(id);
}

async function doLogin(id) {
  busy.add(id);
  logByAccount[id] = "";
  await render();
  setLog(id, "开始登录 …", false);
  const res = await send("login", { accountId: id });
  busy.delete(id);
  if (res && res.ok) {
    setLog(id, "✔ 完成" + (res.quota ? `，额度 $${res.quota.label}` : ""));
    toast("登录成功", "ok");
  } else {
    setLog(id, "✘ " + (res && res.error ? res.error : "失败"));
    toast("登录失败：" + (res && res.error ? res.error : ""), "err");
  }
  await render();
}

async function doSwitch(id) {
  busy.add(id);
  await render();
  const res = await send("switch", { accountId: id });
  busy.delete(id);
  await render();
  if (res && res.ok) {
    toast("已切换，Devin 页面正在刷新为该账号", "ok");
  } else {
    toast("切换失败：" + (res && res.error ? res.error : ""), "err");
  }
}

async function doRemove(id) {
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return;
  if (!confirm(`从插件移除账号 ${acc.username}？（仅本地移除，不影响 Devin/GitHub 账号本身）`)) return;
  await removeAccount(id);
  toast("已移除账号");
  await render();
}

// ---- Sessions panel ----
let panelAccountId = null;
async function openSessions(id) {
  panelAccountId = id;
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === id);
  $("sessSub").textContent = acc ? acc.username : "";
  $("sessList").innerHTML = `<div class="center-note">加载中 …</div>`;
  $("sessOverlay").classList.remove("hidden");
  await loadSessions();
}

async function loadSessions() {
  const res = await send("listSessions", { accountId: panelAccountId });
  const wrap = $("sessList");
  if (!res || !res.ok) {
    wrap.innerHTML = `<div class="center-note">${res && res.error ? esc(res.error) : "加载失败"}</div>`;
    return;
  }
  if (res.items.length === 0) {
    wrap.innerHTML = `<div class="center-note">没有会话</div>`;
    return;
  }
  wrap.innerHTML = res.items.map(sessionHtml).join("");
  wrap.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => deleteSession(btn.dataset.del, btn));
  });
  wrap.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => chrome.tabs.create({ url: btn.dataset.open }));
  });
  wrap.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => openExport(btn.dataset.export, btn.dataset.title));
  });
}

function statusClass(status) {
  const s = (status || "").toLowerCase();
  if (/fail|error/.test(s)) return "err";
  if (/run|work|active|progress/.test(s)) return "run";
  if (/finish|complete|expire|stopped|archiv|suspend|sleep/.test(s)) return "";
  return "warn";
}

function sessionHtml(s) {
  return `
  <div class="session-item" data-sid="${esc(s.id)}">
    <div class="session-main">
      <div class="session-title">${esc(s.title || s.id)}</div>
      <div class="session-meta">
        <span class="st ${statusClass(s.status)}">${esc((s.status || "unknown").toUpperCase())}</span>
        ${s.updatedAt ? `<span>· ${esc(timeAgo(s.updatedAt))}</span>` : ""}
      </div>
    </div>
    ${s.url ? `<button class="btn-sm" data-open="${esc(s.url)}" title="打开">打开</button>` : ""}
    <button class="btn-sm" data-export="${esc(s.id)}" data-title="${esc(s.title || s.id)}" title="导出会话（对话 / 全量）">导出</button>
    <button class="btn-sm danger" data-del="${esc(s.id)}" title="永久删除会话">删除</button>
  </div>`;
}

async function deleteSession(sessionId, btn) {
  if (!confirm("永久删除这个会话？将调用官方删除接口结束并删除会话，不可恢复。")) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  toast("正在删除（如无 API Key 会自动创建）…");
  const res = await send("terminate", { accountId: panelAccountId, sessionId });
  if (res && res.ok) {
    const item = $("sessList").querySelector(`.session-item[data-sid="${CSS.escape(sessionId)}"]`);
    if (item) item.remove();
    toast("已永久删除会话", "ok");
    if (!$("sessList").querySelector(".session-item")) {
      $("sessList").innerHTML = `<div class="center-note">没有会话</div>`;
    }
    await render();
  } else {
    btn.disabled = false;
    btn.textContent = "删除";
    toast("删除失败：" + (res && res.error ? res.error : ""), "err");
  }
}

// ---- Export ----
let exportSid = null;
let exportTitle = "";
let exporting = false;

function openExport(sid, title) {
  exportSid = sid;
  exportTitle = title || sid;
  $("exportSub").textContent = exportTitle;
  const status = $("exportStatus");
  status.className = "export-status hidden";
  status.textContent = "";
  document.querySelectorAll(".export-mode").forEach((b) => (b.disabled = false));
  $("exportOverlay").classList.remove("hidden");
}
function closeExport() {
  if (exporting) return;
  $("exportOverlay").classList.add("hidden");
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function runExport(mode) {
  if (exporting || !exportSid) return;
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === panelAccountId);
  if (!acc || !acc.session) return toast("该账号没有会话 token", "err");
  const { devinUrl } = await getSettings();
  exporting = true;
  document.querySelectorAll(".export-mode").forEach((b) => (b.disabled = true));
  const status = $("exportStatus");
  status.className = "export-status";
  const setStatus = (m) => (status.textContent = m);
  setStatus("准备中 …");
  const res = await exportSession({
    devinUrl,
    token: acc.session.token,
    orgId: acc.session.orgId,
    sessionId: exportSid,
    mode,
    redact: $("optRedact").checked,
    includeThoughts: $("optThoughts").checked,
    includeShell: $("optShell").checked,
    onProgress: setStatus,
  });
  exporting = false;
  document.querySelectorAll(".export-mode").forEach((b) => (b.disabled = false));
  if (res.ok) {
    triggerDownload(res.blob, res.filename);
    const s = res.stats || {};
    setStatus(`完成：${res.filename}（${s.events || 0} 事件，${s.filesModified || 0} 文件）`);
    toast("已导出 " + res.filename, "ok");
    setTimeout(() => $("exportOverlay").classList.add("hidden"), 1200);
  } else {
    status.className = "export-status err";
    setStatus("导出失败：" + (res.error || "未知错误"));
    if (res.expired) toast("会话 token 已过期，请重新登录该账号", "err");
  }
}

$("exportClose").addEventListener("click", closeExport);
$("exportOverlay").addEventListener("click", (e) => {
  if (e.target === $("exportOverlay")) closeExport();
});
document.querySelectorAll(".export-mode").forEach((b) => {
  b.addEventListener("click", () => runExport(b.dataset.xmode));
});

// ---- Import ----
let importMode = "github";
const IMPORT_HINTS = {
  github: 'GitHub 登录：走 GitHub 账密 + TOTP 授权 Devin。每行一个账号：<br /><code>邮箱----密码----TOTP密钥</code>',
  devin: 'Devin 直登：直接用 Devin 邮箱密码登录（无需 TOTP）。每行一个账号：<br /><code>邮箱----密码</code>',
};
const IMPORT_PH = {
  github: "name1@example.com----password1----TOTPSECRET1\nname2@example.com----password2----TOTPSECRET2",
  devin: "name1@example.com----password1\nname2@example.com----password2",
};
function setImportMode(mode) {
  importMode = mode === "devin" ? "devin" : "github";
  document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === importMode));
  $("importHint").innerHTML = IMPORT_HINTS[importMode];
  $("importText").placeholder = IMPORT_PH[importMode];
}
function openImport() {
  $("importOverlay").classList.remove("hidden");
  $("importText").focus();
}
function closeImport() {
  $("importOverlay").classList.add("hidden");
}
$("btnImport").addEventListener("click", openImport);
$("importClose").addEventListener("click", closeImport);
$("importCancel").addEventListener("click", closeImport);
document.querySelectorAll(".seg-btn").forEach((b) => {
  b.addEventListener("click", () => setImportMode(b.dataset.mode));
});
$("importConfirm").addEventListener("click", async () => {
  const entries = parseImportText($("importText").value, importMode);
  if (entries.length === 0) return toast("没解析到有效账号行", "err");
  const r = await upsertImported(entries);
  $("importText").value = "";
  closeImport();
  toast(`已导入 ${r.added} 个新账号${r.updated ? `，更新 ${r.updated} 个` : ""}`, "ok");
  await render();
});

// ---- Refresh all ----
let refreshingAll = false;
$("btnRefreshAll").addEventListener("click", async () => {
  if (refreshingAll) return;
  const accounts = await getAccounts();
  if (!accounts.some((a) => a.session && a.session.token)) return toast("没有已登录的账号可刷新", "err");
  refreshingAll = true;
  const btn = $("btnRefreshAll");
  btn.disabled = true;
  btn.classList.add("spinning");
  toast("正在刷新所有账号 …");
  const res = await send("refreshAll");
  refreshingAll = false;
  btn.disabled = false;
  btn.classList.remove("spinning");
  await render();
  if (res && res.ok) {
    const done = res.results.filter((r) => r.ok).length;
    toast(`已刷新 ${done}/${res.results.length} 个账号`, "ok");
  } else {
    toast("刷新失败", "err");
  }
});

$("search").addEventListener("input", (e) => {
  searchTerm = e.target.value.trim().toLowerCase();
  render();
});

$("sessClose").addEventListener("click", () => $("sessOverlay").classList.add("hidden"));
$("sessRefresh").addEventListener("click", loadSessions);
$("sessOverlay").addEventListener("click", (e) => {
  if (e.target === $("sessOverlay")) $("sessOverlay").classList.add("hidden");
});
$("importOverlay").addEventListener("click", (e) => {
  if (e.target === $("importOverlay")) closeImport();
});

// ---- Dark / light mode ----
function applyMode(mode) {
  document.documentElement.setAttribute("data-mode", mode);
  $("modeToggle").title = mode === "dark" ? "切换到亮色" : "切换到暗色";
}
$("modeToggle").addEventListener("click", async () => {
  const next = document.documentElement.getAttribute("data-mode") === "dark" ? "light" : "dark";
  applyMode(next);
  await saveSettings({ mode: next });
});

// Live login logs from the service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "log" && msg.accountId) setLog(msg.accountId, msg.line);
});

(async () => {
  const { mode } = await getSettings();
  applyMode(mode === "light" ? "light" : "dark");
  await render();
})();
