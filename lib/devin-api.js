// Devin data-plane calls (quota / sessions) reusing a stored session token.
// All authed with Bearer <token> + x-cog-org-id, credentials:'omit'.

export const DEFAULT_DEVIN_URL = "https://app.devin.ai";

function stripTrailingSlash(u) {
  return u.replace(/\/+$/, "");
}

function authHeaders(token, orgId, extra = {}) {
  const h = { authorization: `Bearer ${token}`, accept: "application/json", ...extra };
  if (orgId) h["x-cog-org-id"] = orgId;
  return h;
}

/** Extra quota (overage_balance). Returns { ok, label, raw, expired, error }. */
export async function fetchQuota({ devinUrl, token, orgId }) {
  const result = { ok: false, label: "", raw: null, expired: false, error: "" };
  if (!token) return { ...result, error: "缺少会话 token" };
  if (!orgId) return { ...result, error: "缺少 org id" };
  const base = stripTrailingSlash(devinUrl || DEFAULT_DEVIN_URL);
  const url = `${base}/api/${orgId}/billing/quota/usage`;
  let res;
  try {
    res = await fetch(url, { method: "GET", credentials: "omit", headers: authHeaders(token, orgId) });
  } catch (exc) {
    return { ...result, error: `请求额度接口失败：${String(exc)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...result, expired: true, error: `额度接口被拒（${res.status}）：会话可能已过期。` };
  }
  const text = await res.text();
  if (res.status !== 200) return { ...result, error: `额度接口返回 ${res.status}。` };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...result, error: "额度接口返回的不是 JSON。" };
  }
  result.raw = data;
  const value = data.overage_balance;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ...result, error: "没解析到 overage_balance 字段。" };
  }
  result.ok = true;
  result.label = String(Math.round(value * 100) / 100);
  return result;
}

/**
 * Billing/plan status. Returns { ok, planSlug, valid, expired, error }.
 *   planSlug: "free" | "pro" | "max" | ...
 *   valid:    subscription currently valid (false => "ended")
 */
export async function fetchBillingStatus({ devinUrl, token, orgId }) {
  const result = { ok: false, planSlug: "", valid: true, expired: false, error: "" };
  if (!token) return { ...result, error: "缺少会话 token" };
  if (!orgId) return { ...result, error: "缺少 org id" };
  const base = stripTrailingSlash(devinUrl || DEFAULT_DEVIN_URL);
  let res;
  try {
    res = await fetch(`${base}/api/${orgId}/billing/status`, {
      method: "GET",
      credentials: "omit",
      headers: authHeaders(token, orgId),
    });
  } catch (exc) {
    return { ...result, error: `请求套餐接口失败：${String(exc)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...result, expired: true, error: `套餐接口被拒（${res.status}）。` };
  }
  const text = await res.text();
  if (res.status !== 200) return { ...result, error: `套餐接口返回 ${res.status}。` };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...result, error: "套餐接口返回的不是 JSON。" };
  }
  result.planSlug = pickString(data, ["plan_slug", "planSlug", "slug"]);
  if (typeof data.is_subscription_valid === "boolean") result.valid = data.is_subscription_valid;
  result.ok = true;
  return result;
}

function sessionWebUrl(devinUrl, id) {
  const cleanId = id.replace(/^devin-/i, "").trim();
  if (!cleanId) return "";
  return stripTrailingSlash(devinUrl) + "/sessions/" + cleanId;
}

function pickString(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return "";
}

function toSessionItem(obj, devinUrl) {
  const id = pickString(obj, ["devin_id", "session_id", "sessionId", "id"]);
  let prUrl = pickString(obj, ["pr_url", "prUrl", "pull_request_url"]);
  if (!prUrl && obj.pull_request && typeof obj.pull_request === "object") {
    prUrl = pickString(obj.pull_request, ["url", "html_url", "link"]);
  }
  return {
    id,
    title: pickString(obj, ["title", "name", "task", "prompt"]) || id,
    status: pickString(obj, ["status_enum", "status", "state"]),
    createdAt: pickString(obj, ["created_at", "createdAt", "created"]),
    updatedAt: pickString(obj, ["updated_at", "updatedAt", "updated", "last_updated_at"]),
    url: sessionWebUrl(devinUrl, id),
    prUrl,
  };
}

function parseSessionsResponse(json, devinUrl) {
  if (json === null || typeof json !== "object") return { items: [], nextCursor: "" };
  let rawList = [];
  let nextCursor = "";
  if (Array.isArray(json)) {
    rawList = json;
  } else {
    const named = json.result ?? json.results ?? json.sessions ?? json.v2sessions ?? json.items ?? json.data;
    rawList = Array.isArray(named)
      ? named
      : Object.values(json).filter((v) => v && typeof v === "object" && !Array.isArray(v));
    nextCursor = pickString(json, ["next_cursor", "nextCursor", "cursor", "next"]);
  }
  const items = rawList
    .filter((v) => !!v && typeof v === "object")
    .map((v) => toSessionItem(v, devinUrl))
    .filter((it) => it.id !== "");
  return { items, nextCursor };
}

/** List sessions. Returns { ok, items, nextCursor, expired, error }. */
export async function listSessions({ devinUrl, token, orgId, limit = 30, cursor = "" }) {
  const result = { ok: false, items: [], nextCursor: "", expired: false, error: "" };
  if (!token) return { ...result, error: "缺少会话 token" };
  if (!orgId) return { ...result, error: "缺少 org id" };
  const base = stripTrailingSlash(devinUrl || DEFAULT_DEVIN_URL);
  const qs = new URLSearchParams();
  qs.append("limit", String(limit));
  if (cursor) qs.append("cursor", cursor);
  const url = `${base}/api/${orgId}/v2sessions?${qs.toString()}`;
  let res;
  try {
    res = await fetch(url, { method: "GET", credentials: "omit", headers: authHeaders(token, orgId) });
  } catch (exc) {
    return { ...result, error: `请求会话列表失败：${String(exc)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...result, expired: true, error: `列会话被拒（${res.status}）：会话可能已过期。` };
  }
  const text = await res.text();
  if (res.status !== 200) return { ...result, error: `会话列表接口返回 ${res.status}。` };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...result, error: "会话列表返回的不是 JSON。" };
  }
  const parsed = parseSessionsResponse(data, base);
  result.items = parsed.items;
  result.nextCursor = parsed.nextCursor;
  result.ok = true;
  return result;
}

/**
 * Provision an org service user and return its API key (cog_...).
 * Two calls, both authed with the web session token:
 *   POST /api/organizations/{orgId}/service-users        { name, expiration_days }
 *   POST /api/organizations/{orgId}/service-users/{id}/roles { role_id }
 * Returns { ok, apiKey, serviceUserId, expired, error }.
 */
export async function provisionServiceKey({
  devinUrl,
  token,
  orgId,
  name,
  expirationDays = 30,
  roleId = "org_admin",
}) {
  const result = { ok: false, apiKey: "", serviceUserId: "", expired: false, error: "" };
  if (!token) return { ...result, error: "缺少会话 token" };
  if (!orgId) return { ...result, error: "缺少 org id" };
  const base = stripTrailingSlash(devinUrl || DEFAULT_DEVIN_URL);
  let res;
  try {
    res = await fetch(`${base}/api/organizations/${orgId}/service-users`, {
      method: "POST",
      credentials: "omit",
      headers: authHeaders(token, orgId, { "content-type": "application/json" }),
      body: JSON.stringify({ name, expiration_days: expirationDays }),
    });
  } catch (exc) {
    return { ...result, error: `创建 Service Key 请求失败：${String(exc)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ...result,
      expired: true,
      error: `创建 Service Key 被拒（${res.status}）：会话可能已过期，或该账号不是组织管理员。`,
    };
  }
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    return { ...result, error: `创建 Service Key 接口返回 ${res.status}。` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...result, error: "创建 Service Key 返回的不是 JSON。" };
  }
  const apiKey = pickString(data, ["token", "api_key", "key"]);
  const serviceUserId = pickString(data, ["service_user_id", "id"]);
  if (!apiKey) return { ...result, error: "创建 Service Key 响应缺少 token 字段。" };
  if (serviceUserId && roleId) {
    // Grant the role so the key can call the v3 API. Best-effort: the request
    // mirrors what the Devin settings page sends when provisioning.
    try {
      await fetch(`${base}/api/organizations/${orgId}/service-users/${serviceUserId}/roles`, {
        method: "POST",
        credentials: "omit",
        headers: authHeaders(token, orgId, { "content-type": "application/json" }),
        body: JSON.stringify({ role_id: roleId }),
      });
    } catch {
      // Key may still work; deletion path will surface real failures.
    }
  }
  return { ...result, ok: true, apiKey, serviceUserId };
}

/**
 * Permanently delete (terminate) a session via the official v3 endpoint:
 *   DELETE https://api.devin.ai/v3/organizations/{orgId}/sessions/{sessionId}
 * Requires a service-user API key (Bearer cog_...). The session id must be the
 * bare 32-hex id, without the "devin-" prefix. No archive fallback.
 * Returns { ok, expired, error }.
 */
export async function deleteSession({ orgId, apiKey, sessionId }) {
  const result = { ok: false, expired: false, error: "" };
  if (!apiKey || !apiKey.trim()) return { ...result, error: "缺少 API Key" };
  if (!orgId) return { ...result, error: "缺少 org id" };
  const id = (sessionId || "").trim().replace(/^devin-/i, "");
  if (!id) return { ...result, error: "缺少会话 id" };
  let res;
  try {
    res = await fetch(`https://api.devin.ai/v3/organizations/${orgId}/sessions/${id}`, {
      method: "DELETE",
      credentials: "omit",
      headers: { authorization: `Bearer ${apiKey.trim()}`, accept: "application/json" },
    });
  } catch (exc) {
    return { ...result, error: `删除会话请求失败：${String(exc)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ...result, expired: true, error: `删除被拒（${res.status}）：API Key 可能已失效。` };
  }
  if (res.status < 200 || res.status >= 300) {
    const body = await res.text().catch(() => "");
    return { ...result, error: `删除接口返回 ${res.status}${body ? `：${body.slice(0, 120)}` : ""}` };
  }
  return { ...result, ok: true };
}
