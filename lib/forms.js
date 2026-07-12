// Parse GitHub login / 2FA / OAuth consent <form> pages. Mirrors the VSIX
// extension's forms.ts: only reads <input>/<button> name/value pairs.

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttrs(tag) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(tag)) !== null) {
    const key = m[1].toLowerCase();
    out[key] = m[3] ?? m[4] ?? m[5] ?? "";
  }
  return out;
}

/** Unescape HTML entities: &amp; &lt; &gt; &quot; &#39; &#x..; &#..; */
export function htmlUnescape(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Extract every <form> together with its <input>/<button> name/value pairs. */
export function parseForms(html) {
  const forms = [];
  const formOpenRe = /<form\b([^>]*)>/gi;
  let m;
  while ((m = formOpenRe.exec(html)) !== null) {
    const attrs = parseAttrs(m[1]);
    const start = formOpenRe.lastIndex;
    const closeIdx = html.toLowerCase().indexOf("</form>", start);
    const inner = closeIdx === -1 ? html.slice(start) : html.slice(start, closeIdx);
    const inputs = {};
    const fieldRe = /<(input|button)\b([^>]*?)\/?>/gi;
    let fm;
    while ((fm = fieldRe.exec(inner)) !== null) {
      const a = parseAttrs(fm[2]);
      const name = a["name"];
      if (!name) continue;
      const hasValue = a["value"] !== undefined && a["value"] !== "";
      if (!(name in inputs) || hasValue) {
        inputs[name] = htmlUnescape(a["value"] ?? "");
      }
    }
    forms.push({
      action: htmlUnescape(attrs["action"] ?? ""),
      method: (attrs["method"] || "get").toLowerCase(),
      inputs,
    });
  }
  return forms;
}

/** Pick a form by action-substring / has-field, first match. */
export function findForm(html, opts = {}) {
  for (const form of parseForms(html)) {
    if (opts.actionContains !== undefined && !form.action.includes(opts.actionContains)) continue;
    if (opts.hasField !== undefined && !(opts.hasField in form.inputs)) continue;
    return form;
  }
  return null;
}

/** 2FA OTP field name varies (app_otp / otp / sms_otp …), prefer app_otp. */
export function otpFieldName(inputs) {
  const otpFields = Object.keys(inputs).filter((k) => k.toLowerCase().includes("otp"));
  if (otpFields.length === 0) return null;
  for (const pref of ["app_otp", "otp"]) {
    if (otpFields.includes(pref)) return pref;
  }
  return otpFields[0];
}
