// Account persistence on chrome.storage.local.
//
// Account shape:
//   { id, username, password, totp, note,
//     session: { token, userId, orgId, orgName, email, updatedAt } | null,
//     quota: { label, updatedAt } | null,
//     apiKey?: string,          // service-user API key (cog_...), runtime only
//     serviceUserId?: string,   // id of the provisioned service user
//     hiddenSessions?: string[] // ids deleted via the extension, hidden locally }

const KEY = "das_accounts";
const SETTINGS_KEY = "das_settings";

export async function getAccounts() {
  const obj = await chrome.storage.local.get(KEY);
  return Array.isArray(obj[KEY]) ? obj[KEY] : [];
}

export async function saveAccounts(accounts) {
  await chrome.storage.local.set({ [KEY]: accounts });
}

export async function getSettings() {
  const obj = await chrome.storage.local.get(SETTINGS_KEY);
  return { devinUrl: "https://app.devin.ai", activeId: "", ...(obj[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

function genId() {
  return "acc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Parse pasted bulk import text. Separators: ---- | , | tab | 2+ spaces.
 *   github mode: email----password----TOTPSECRET  (TOTP optional)
 *   devin  mode: email----password                (direct Devin login)
 * Returns [{ username, password, totp, loginMode }].
 */
export function parseImportText(text, mode = "github") {
  const loginMode = mode === "devin" ? "devin" : "github";
  const lines = (text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    let parts;
    if (line.includes("----")) parts = line.split("----");
    else parts = line.split(/[,\t]+|\s{2,}/);
    parts = parts.map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const [username, password, totp = ""] = parts;
    parsed.push({ username, password, totp: loginMode === "devin" ? "" : totp, loginMode });
  }
  return parsed;
}

export async function upsertImported(entries) {
  const accounts = await getAccounts();
  const byName = new Map(accounts.map((a) => [a.username.toLowerCase(), a]));
  let added = 0;
  let updated = 0;
  for (const e of entries) {
    const existing = byName.get(e.username.toLowerCase());
    if (existing) {
      existing.password = e.password;
      existing.totp = e.totp;
      existing.loginMode = e.loginMode;
      updated++;
    } else {
      const acc = {
        id: genId(),
        username: e.username,
        password: e.password,
        totp: e.totp,
        loginMode: e.loginMode,
        note: "",
        session: null,
        quota: null,
        plan: null,
      };
      accounts.push(acc);
      byName.set(e.username.toLowerCase(), acc);
      added++;
    }
  }
  await saveAccounts(accounts);
  return { added, updated, total: accounts.length };
}

export async function removeAccount(id) {
  const accounts = (await getAccounts()).filter((a) => a.id !== id);
  await saveAccounts(accounts);
  return accounts;
}

export async function updateAccount(id, patch) {
  const accounts = await getAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return null;
  Object.assign(acc, patch);
  await saveAccounts(accounts);
  return acc;
}
