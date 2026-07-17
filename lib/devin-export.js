// Export a Devin session for AI handoff, ported from the devin_recover.py
// recovery tool. Uses the account's stored auth1 web-session token to hit the
// internal /api/* endpoints (event stream + presigned blob URLs), reconstructs
// the conversation and the before/after file snapshots, and packages them.
//
//   mode "chat" -> a single conversation.md (no blob downloads)
//   mode "full" -> conversation.md + final/ + original/ + diffs/ + patch, zipped
//
// Everything runs with plain fetch so it works from the dashboard page (which
// has host permissions for app.devin.ai and *.blob.core.windows.net).

import { DEFAULT_DEVIN_URL } from "./devin-api.js";

const DEFAULT_REPO_PREFIX = "/home/ubuntu/repos/";

const USER_TYPES = new Set(["initial_user_message", "user_message", "user_question_answered"]);
const DEVIN_MSG_TYPES = new Set(["devin_message"]);
const THOUGHT_TYPES = new Set(["devin_thoughts", "one_line_thoughts"]);
const TODO_TYPES = new Set(["todo_update"]);
const STATUS_TYPES = new Set([
  "status_update",
  "devin_suspended",
  "self_suspend",
  "resume_requested_frontend",
  "resuming_session",
]);
const ITER_TYPES = new Set(["iteration_checkpoint", "session_snapshot"]);

function stripTrailingSlash(u) {
  return String(u || "").replace(/\/+$/, "");
}

function withDevinPrefix(id) {
  const s = String(id || "").trim();
  return s.startsWith("devin-") ? s : "devin-" + s;
}

function authHeaders(token, orgId, extra = {}) {
  const h = { authorization: `Bearer ${token}`, accept: "application/json", ...extra };
  if (orgId) h["x-cog-org-id"] = orgId;
  return h;
}

// ── secret / noise scrubbing ────────────────────────────────────────────────
const SECRET_PATTERNS = [
  [/\bapk_user_[A-Za-z0-9+/=_-]{20,}/g, "[REDACTED devin-personal-api-key]"],
  [/\bapk_[A-Za-z0-9+/=_-]{20,}/g, "[REDACTED devin-service-api-key]"],
  [/\bcog_[A-Za-z0-9]{30,}/g, "[REDACTED devin-service-user-token]"],
  [/\bauth1_[A-Za-z0-9]{20,}/g, "[REDACTED devin-auth1-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED github-fine-grained-pat]"],
  [/\bghp_[A-Za-z0-9]{20,}/g, "[REDACTED github-classic-pat]"],
  [/\bgho_[A-Za-z0-9]{20,}/g, "[REDACTED github-oauth-token]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED gitlab-pat]"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED openai-or-anthropic-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED aws-access-key-id]"],
  [/\bxox[bp]-[A-Za-z0-9-]{20,}/g, "[REDACTED slack-token]"],
  [
    /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    "[REDACTED jwt-or-signed-token]",
  ],
];
const NOISE_PATTERNS = [
  /^\s*<system_note>[\s\S]*?<\/system_note>\s*/gm,
  /^\s*<rules>[\s\S]*?<\/rules>\s*/gm,
  /^\s*<available_rules>[\s\S]*?<\/available_rules>\s*/gm,
  /^\s*<knowledge-hints>[\s\S]*?<\/knowledge-hints>\s*/gm,
];
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

function redactSecrets(text, redact) {
  if (!redact || !text) return text || "";
  let out = text;
  for (const [pat, repl] of SECRET_PATTERNS) out = out.replace(pat, repl);
  return out;
}

function cleanMessage(msg, redact) {
  if (!msg) return "";
  let out = String(msg);
  for (const pat of NOISE_PATTERNS) out = out.replace(pat, "");
  out = out.replace(HTML_COMMENT, "");
  out = redactSecrets(out, redact);
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

function tsToIso(ms) {
  if (!ms) return "";
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function safe(s, limit = 200) {
  s = String(s || "").trim();
  if (s.length > limit) s = s.slice(0, limit).trimEnd() + "…";
  return s;
}

function nowIso() {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// ── network ─────────────────────────────────────────────────────────────────
async function fetchMeta(base, token, orgId, sid) {
  try {
    const res = await fetch(`${base}/api/sessions/${sid}`, {
      credentials: "omit",
      headers: authHeaders(token, orgId),
    });
    if (res.status === 401 || res.status === 403) {
      return { meta: { devin_id: sid }, expired: true };
    }
    if (res.status !== 200) return { meta: { devin_id: sid } };
    return { meta: await res.json() };
  } catch {
    return { meta: { devin_id: sid } };
  }
}

async function fetchEventStream(base, token, orgId, sid) {
  const res = await fetch(`${base}/api/events/${sid}/stream`, {
    credentials: "omit",
    headers: authHeaders(token, orgId, { accept: "application/x-ndjson" }),
  });
  if (res.status === 401 || res.status === 403) {
    const e = new Error("会话 token 已过期或无权限（" + res.status + "），请对该账号重新登录。");
    e.expired = true;
    throw e;
  }
  if (res.status !== 200) throw new Error("事件流接口返回 " + res.status + "。");
  const raw = await res.text();
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && Array.isArray(obj.result)) events.push(...obj.result);
    else if (Array.isArray(obj)) events.push(...obj);
  }
  events.sort((a, b) => (a.created_at_ms || 0) - (b.created_at_ms || 0));
  return events;
}

async function presignedUrls(base, token, orgId, sid, keys, chunk = 40) {
  const out = {};
  for (let i = 0; i < keys.length; i += chunk) {
    const batch = keys.slice(i, i + chunk);
    const res = await fetch(`${base}/api/presigned-url/batch/${sid}`, {
      method: "POST",
      credentials: "omit",
      headers: authHeaders(token, orgId, { "content-type": "application/json" }),
      body: JSON.stringify({ s3_key_list: batch }),
    });
    if (res.status !== 200) throw new Error("换取 presigned URL 返回 " + res.status + "。");
    const data = await res.json();
    const urls = data.urls_list || [];
    batch.forEach((k, idx) => {
      if (urls[idx]) out[k] = urls[idx];
    });
  }
  return out;
}

// ── event parsing ───────────────────────────────────────────────────────────
function collectFileEdits(events) {
  const out = [];
  for (const e of events) {
    if (e.type !== "multi_edit_result") continue;
    const ts = e.created_at_ms || 0;
    const hasWrite = Boolean(e.has_write);
    for (const fu of e.file_updates || []) {
      const ck = fu.contents_key;
      if (!ck) continue;
      out.push({
        filePath: fu.file_path || "",
        contentsKey: ck,
        prevContentsKey: fu.prev_contents_key || null,
        actionType: fu.action_type || "",
        hasWrite,
        ts,
      });
    }
  }
  return out;
}

function aggregateFileStates(edits) {
  const byFile = new Map();
  for (const ed of edits) {
    if (!ed.filePath) continue;
    if (!byFile.has(ed.filePath)) byFile.set(ed.filePath, []);
    byFile.get(ed.filePath).push(ed);
  }
  const out = [];
  for (const [fp, ops] of byFile) {
    const writes = ops.filter((o) => o.hasWrite).sort((a, b) => a.ts - b.ts);
    if (writes.length === 0) continue;
    const first = writes[0];
    const last = writes[writes.length - 1];
    out.push({
      filePath: fp,
      finalKey: last.contentsKey,
      beforeKey: first.prevContentsKey,
      isNew: first.actionType === "create",
      totalWrites: writes.length,
    });
  }
  out.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return out;
}

function relPath(p, prefix) {
  if (p.startsWith(prefix)) return p.slice(prefix.length);
  return p.replace(/^\/+/, "");
}

// ── conversation rendering ──────────────────────────────────────────────────
function renderHandoffHeader(meta, files, prefix) {
  const sid = meta.devin_id || meta.session_id || "";
  const title = meta.title || meta.name || "(untitled)";
  const status = meta.status || meta.session_state || "";
  const sc = meta.latest_status_contents || {};
  const reason = sc.reason || meta.self_suspend_reason || meta.status_reason || "";
  const suspendMsg = sc.message || "";
  const repo = meta.repo || meta.repo_name || meta.repository || "";
  const branch = meta.branch || meta.git_branch || "";
  const created = meta.created_at || "";
  const updated = meta.updated_at || "";
  const activity = meta.activity_status || "";
  const lastMsg = (meta.latest_message_contents || {}).message || "";

  const newFiles = files.filter((f) => f.isNew);
  const modFiles = files.filter((f) => !f.isNew);
  const rel = (p) => relPath(p, prefix);

  const L = [
    "# Devin Session Handoff",
    "",
    "> This document is an EXPORT of a previous Devin session.  ",
    "> If you are an AI assistant reading this, treat it as **context for resuming the task**.",
    "",
    "## How to use this handoff",
    "",
    "1. Read **Session metadata** + **Last action** to understand where the session stopped",
    "2. Skim **Files modified** to see what's already done",
    "3. Read **Conversation** to understand the user's intent and any unresolved questions",
    "4. If `final/` / `diffs/` / `ALL_CHANGES.patch` ship alongside this file, they hold the",
    "   actual code changes — read them to understand state, or apply them before continuing",
    "5. Continue the task; ask the user only when something is genuinely unclear",
    "6. **Do not invent context** — trust the previous Devin's last message unless files disagree",
    "",
    "## Session metadata",
    "",
    "- **Devin session id**: `" + sid + "`",
    "- **Title**: " + title,
    "- **Status**: `" + status + "`" +
      (reason || suspendMsg
        ? " (reason: `" + reason + "`" + (suspendMsg ? ", " + suspendMsg : "") + ")"
        : ""),
  ];
  if (repo) L.push("- **Repo**: `" + repo + "`");
  if (branch) L.push("- **Branch**: `" + branch + "`");
  if (created) L.push("- **Created**: " + created);
  if (updated) L.push("- **Last updated**: " + updated);
  if (activity) L.push("- **Last activity**: `" + activity + "`");
  L.push("- **Exported at**: " + nowIso());
  L.push("");

  if (lastMsg) {
    L.push("## Last action from previous Devin", "");
    let cleaned = cleanMessage(lastMsg, true);
    if (cleaned.length > 2500) cleaned = cleaned.slice(0, 2500).trimEnd() + "…";
    L.push(cleaned, "");
  }

  let out = L.join("\n") + "\n";
  out += "## Files modified by previous session\n\n";
  if (files.length === 0) {
    out += "_No file modifications detected in this session._\n\n";
  } else {
    out += `**Total**: ${files.length} files (${newFiles.length} new, ${modFiles.length} modified)\n\n`;
    if (newFiles.length) {
      out += "### New files\n\n";
      for (const f of newFiles.slice(0, 200)) out += `- \`${rel(f.filePath)}\`  (${f.totalWrites} write(s))\n`;
      if (newFiles.length > 200) out += `- _…and ${newFiles.length - 200} more_\n`;
      out += "\n";
    }
    if (modFiles.length) {
      out += "### Modified files\n\n";
      for (const f of modFiles.slice(0, 200)) out += `- \`${rel(f.filePath)}\`  (${f.totalWrites} write(s))\n`;
      if (modFiles.length > 200) out += `- _…and ${modFiles.length - 200} more_\n`;
      out += "\n";
    }
  }
  return out;
}

function renderConversation(events, { includeThoughts, includeShell, redact, prefix }) {
  const out = ["## Conversation\n\n"];
  let editFiles = [];
  let editWrites = 0;
  let shellCount = 0;
  const rel = (p) => relPath(p, prefix);

  const flushEdits = () => {
    if (editWrites === 0) return;
    const uniq = [...new Set(editFiles)].sort();
    let filesStr;
    if (uniq.length <= 4) filesStr = uniq.map((f) => "`" + rel(f) + "`").join(", ");
    else
      filesStr =
        uniq.slice(0, 3).map((f) => "`" + rel(f) + "`").join(", ") + `, … _+${uniq.length - 3} more_`;
    out.push(`> **[tool] Devin edited ${editWrites} time(s) across ${uniq.length} file(s)**: ${filesStr}\n\n`);
    editFiles = [];
    editWrites = 0;
  };
  const flushShell = () => {
    if (shellCount === 0) return;
    out.push(`> **[tool] Devin ran ${shellCount} shell command(s)**\n\n`);
    shellCount = 0;
  };

  for (const e of events) {
    const t = e.type;
    const ts = tsToIso(e.created_at_ms || 0);

    if (USER_TYPES.has(t)) {
      flushEdits();
      flushShell();
      const msg = e.message || e.answer || "";
      if (t === "user_question_answered") {
        out.push(`### 👤 User answered — ${ts}\n\n**Q:** ${safe(e.question || "")}\n\n**A:** ${safe(msg)}\n\n`);
      } else {
        out.push(`### 👤 User — ${ts}\n\n${cleanMessage(msg, redact)}\n\n`);
      }
      continue;
    }
    if (DEVIN_MSG_TYPES.has(t)) {
      flushEdits();
      flushShell();
      const msg = cleanMessage(e.message || "", redact);
      if (msg) out.push(`### 🤖 Devin — ${ts}\n\n${msg}\n\n`);
      continue;
    }
    if (includeThoughts && THOUGHT_TYPES.has(t)) {
      flushEdits();
      flushShell();
      let content = e.thoughts || e.content || "";
      if (Array.isArray(content)) content = content.map((x) => String(x)).join("\n");
      content = cleanMessage(String(content), redact);
      if (content) out.push(`<details><summary>💭 Devin thought (${ts})</summary>\n\n${content}\n\n</details>\n\n`);
      continue;
    }
    if (TODO_TYPES.has(t)) {
      flushEdits();
      flushShell();
      const todos = e.todos || [];
      if (todos.length) {
        const lines = ["### 📋 TODO list updated — " + ts, ""];
        for (const td of todos) {
          const st = (td.status || "").toLowerCase();
          const icon = st === "completed" ? "x" : st === "in_progress" ? "~" : " ";
          lines.push(`- [${icon}] ${safe(td.content || "")}`);
        }
        lines.push("");
        out.push(lines.join("\n") + "\n");
      }
      continue;
    }
    if (ITER_TYPES.has(t)) {
      flushEdits();
      flushShell();
      const n = e.iteration ?? e.checkpoint_number;
      if (n !== undefined && n !== null) out.push(`> **[checkpoint] Iteration ${n}** at ${ts}\n\n`);
      continue;
    }
    if (STATUS_TYPES.has(t)) {
      flushEdits();
      flushShell();
      const tag = [e.enum || e.status || "", e.reason || ""].filter(Boolean).join(" ");
      const extra = e.message || "";
      if (tag || extra) out.push(`> **[status]** ${tag}${extra ? " — " + safe(extra) : ""}  _(${ts})_\n\n`);
      continue;
    }
    if (t === "multi_edit_result") {
      if (e.has_write) {
        for (const fu of e.file_updates || []) {
          editWrites += 1;
          if (fu.file_path) editFiles.push(fu.file_path);
        }
      }
      continue;
    }
    if (includeShell && t === "shell_process_started") {
      shellCount += 1;
      continue;
    }
  }
  flushEdits();
  flushShell();
  return out.join("");
}

// ── store-only ZIP writer ───────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = 0x21; // 1980-01-01
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data instanceof Uint8Array ? e.data : enc.encode(String(e.data));
    const crc = crc32(data);
    const size = data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 filenames
    lh.setUint16(8, 0, true); // store
    lh.setUint16(10, DOS_TIME, true);
    lh.setUint16(12, DOS_DATE, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, DOS_TIME, true);
    cd.setUint16(14, DOS_DATE, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push({ header: new Uint8Array(cd.buffer), name: nameBytes });
    offset += 30 + nameBytes.length + size;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    chunks.push(c.header, c.name);
    cdSize += c.header.length + c.name.length;
  }
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  chunks.push(new Uint8Array(eocd.buffer));
  return new Blob(chunks, { type: "application/zip" });
}

function unifiedDiff(origText, finalText, rel, isNew) {
  const a = origText === "" ? [] : origText.split(/(?<=\n)/);
  const b = finalText === "" ? [] : finalText.split(/(?<=\n)/);
  return diffLines(a, b, isNew || origText === "" ? "/dev/null" : "a/" + rel, "b/" + rel);
}

// Minimal unified diff (Myers) over line arrays.
function diffLines(a, b, fromLabel, toLabel) {
  const ops = myers(a, b);
  if (!ops.some((o) => o.t !== "eq")) return "";
  const header = `--- ${fromLabel}\n+++ ${toLabel}\n`;
  // Build hunks with 3 lines of context.
  const ctx = 3;
  const lines = [];
  let ai = 0;
  let bi = 0;
  const tagged = [];
  for (const o of ops) {
    if (o.t === "eq") {
      tagged.push({ t: " ", line: o.line, a: ai, b: bi });
      ai++;
      bi++;
    } else if (o.t === "del") {
      tagged.push({ t: "-", line: o.line, a: ai, b: bi });
      ai++;
    } else {
      tagged.push({ t: "+", line: o.line, a: ai, b: bi });
      bi++;
    }
  }
  const changeIdx = tagged.map((x, i) => (x.t !== " " ? i : -1)).filter((i) => i >= 0);
  if (changeIdx.length === 0) return "";
  const hunks = [];
  let start = Math.max(0, changeIdx[0] - ctx);
  let end = Math.min(tagged.length - 1, changeIdx[0] + ctx);
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k];
    if (idx - ctx <= end + 1) {
      end = Math.min(tagged.length - 1, idx + ctx);
    } else {
      hunks.push([start, end]);
      start = Math.max(0, idx - ctx);
      end = Math.min(tagged.length - 1, idx + ctx);
    }
  }
  hunks.push([start, end]);
  for (const [s, e] of hunks) {
    let aStart = null;
    let bStart = null;
    let aCount = 0;
    let bCount = 0;
    const body = [];
    for (let i = s; i <= e; i++) {
      const x = tagged[i];
      if (aStart === null) {
        aStart = x.a;
        bStart = x.b;
      }
      if (x.t === " ") {
        aCount++;
        bCount++;
      } else if (x.t === "-") aCount++;
      else bCount++;
      body.push(x.t + x.line.replace(/\n$/, ""));
      if (!x.line.endsWith("\n")) body.push("\\ No newline at end of file");
    }
    const aPos = aCount === 0 ? 0 : aStart + 1;
    const bPos = bCount === 0 ? 0 : bStart + 1;
    lines.push(`@@ -${aPos},${aCount} +${bPos},${bCount} @@`);
    lines.push(...body);
  }
  return header + lines.join("\n") + "\n";
}

// Myers diff producing eq/del/ins ops over arrays of lines.
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = {};
  v[1] = 0;
  const trace = [];
  let reached = false;
  for (let d = 0; d <= max && !reached; d++) {
    const vc = {};
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v[k - 1] || 0) < (v[k + 1] || 0))) x = v[k + 1] || 0;
      else x = (v[k - 1] || 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      vc[k] = x;
      if (x >= n && y >= m) {
        reached = true;
      }
    }
    trace.push(vc);
    Object.assign(v, vc);
  }
  // Backtrack
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vc = trace[d - 1];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && (vc[k - 1] || 0) < (vc[k + 1] || 0))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vc[prevK] || 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: "eq", line: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ t: "ins", line: b[y - 1] });
        y--;
      } else {
        ops.push({ t: "del", line: a[x - 1] });
        x--;
      }
    }
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    ops.push({ t: "eq", line: a[x - 1] });
    x--;
    y--;
  }
  while (x > 0) {
    ops.push({ t: "del", line: a[x - 1] });
    x--;
  }
  while (y > 0) {
    ops.push({ t: "ins", line: b[y - 1] });
    y--;
  }
  ops.reverse();
  return ops;
}

function sanitizeTitle(title) {
  return (
    String(title || "")
      .slice(0, 40)
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "session"
  );
}

// ── public API ──────────────────────────────────────────────────────────────
/**
 * Export one session. Returns { ok, filename, blob, stats, expired, error }.
 *   opts: { devinUrl, token, orgId, sessionId, mode ("chat"|"full"),
 *           redact, includeThoughts, includeShell, repoPrefix, onProgress }
 */
export async function exportSession(opts) {
  const {
    devinUrl,
    token,
    orgId,
    sessionId,
    mode = "full",
    redact = true,
    includeThoughts = false,
    includeShell = false,
    repoPrefix = DEFAULT_REPO_PREFIX,
    onProgress = () => {},
  } = opts;
  const result = { ok: false, filename: "", blob: null, stats: {}, expired: false, error: "" };
  if (!token) return { ...result, error: "缺少会话 token" };
  if (!orgId) return { ...result, error: "缺少 org id" };
  if (!sessionId) return { ...result, error: "缺少会话 id" };

  const base = stripTrailingSlash(devinUrl || DEFAULT_DEVIN_URL);
  const sid = withDevinPrefix(sessionId);

  try {
    onProgress("拉取会话元数据 …");
    const { meta, expired: metaExpired } = await fetchMeta(base, token, orgId, sid);
    if (!meta.devin_id) meta.devin_id = sid;

    onProgress("拉取事件流 …");
    let events;
    try {
      events = await fetchEventStream(base, token, orgId, sid);
    } catch (exc) {
      if (metaExpired || exc.expired) return { ...result, expired: true, error: exc.message };
      throw exc;
    }

    const states = aggregateFileStates(collectFileEdits(events));
    const header = renderHandoffHeader(meta, states, repoPrefix);
    const body = renderConversation(events, { includeThoughts, includeShell, redact, prefix: repoPrefix });
    const convMd = header + body;

    const title = sanitizeTitle(meta.title);
    const baseName = `${sid}__${title}`;
    const stats = {
      events: events.length,
      filesModified: states.length,
      filesNew: states.filter((s) => s.isNew).length,
    };

    if (mode === "chat") {
      onProgress("生成对话 Markdown …");
      result.blob = new Blob([convMd], { type: "text/markdown;charset=utf-8" });
      result.filename = `${baseName}__conversation.md`;
      return { ...result, ok: true, stats };
    }

    // full mode: download blobs + build zip
    const entries = [];
    const root = baseName + "/";
    entries.push({ name: root + "conversation.md", data: convMd });

    if (states.length > 0) {
      const keys = new Set();
      for (const f of states) {
        keys.add(f.finalKey);
        if (f.beforeKey) keys.add(f.beforeKey);
      }
      onProgress(`换取 ${keys.size} 个文件的下载地址 …`);
      const resolved = await presignedUrls(base, token, orgId, sid, [...keys]);

      onProgress(`下载 ${Object.keys(resolved).length} 个文件快照 …`);
      const contents = {};
      const keyList = Object.keys(resolved);
      const CONCURRENCY = 12;
      let i = 0;
      const worker = async () => {
        while (i < keyList.length) {
          const k = keyList[i++];
          try {
            const r = await fetch(resolved[k], { credentials: "omit" });
            if (r.ok) contents[k] = new Uint8Array(await r.arrayBuffer());
          } catch {
            /* skip missing blob */
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keyList.length) }, worker));

      onProgress("重建文件与 diff …");
      const dec = new TextDecoder("utf-8", { fatal: false });
      const manifest = [];
      const combined = [];
      for (const f of states) {
        const rel = relPath(f.filePath, repoPrefix);
        const finalBytes = contents[f.finalKey];
        if (!finalBytes) continue;
        entries.push({ name: root + "final/" + rel, data: finalBytes });

        let origText = "";
        let origSize = null;
        if (f.beforeKey && contents[f.beforeKey]) {
          const ob = contents[f.beforeKey];
          entries.push({ name: root + "original/" + rel, data: ob });
          origText = dec.decode(ob);
          origSize = ob.length;
        }
        const finalText = dec.decode(finalBytes);
        const patch = unifiedDiff(origText, finalText, rel, f.isNew);
        entries.push({ name: root + "diffs/" + rel + ".patch", data: patch });
        if (patch) {
          combined.push(`diff --git a/${rel} b/${rel}\n`);
          if (f.isNew || !origText) combined.push("new file mode 100644\n");
          combined.push(patch);
        }
        manifest.push({
          path: rel,
          is_new: f.isNew,
          final_size: finalBytes.length,
          original_size: origSize,
          writes: f.totalWrites,
        });
      }
      entries.push({ name: root + "ALL_CHANGES.patch", data: combined.join("") });
      entries.push({ name: root + "MANIFEST.json", data: JSON.stringify(manifest, null, 2) });
    }

    onProgress("打包 ZIP …");
    result.blob = makeZip(entries);
    result.filename = `${baseName}.zip`;
    return { ...result, ok: true, stats };
  } catch (exc) {
    return { ...result, expired: Boolean(exc.expired), error: String(exc && exc.message ? exc.message : exc) };
  }
}
