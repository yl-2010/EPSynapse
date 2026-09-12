/**
 * School Outlook via the Outlook on the web public client.
 * Mail.Read / Mail.Send work. Files.ReadWrite does not (AADSTS65002).
 * Tokens stay on the student profile. No Entra app registration.
 */

export const OUTLOOK_WEB_CLIENT_ID = "9199bf20-a13f-4107-85dc-02114787ef48";
export const GRAPH_EXPLORER_CLIENT_ID = "de8bc8b5-d9f9-48b1-a8ad-b748da725064";
export const EPS_TENANT_ID = "b2681e8b-dd20-46cf-b163-371a2d7c6014";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const OUTLOOK_REST_BASE = "https://outlook.office.com/api/v2.0";
export const OWA_URL = "https://outlook.office.com/mail/";

const LOGIN = `https://login.microsoftonline.com/${EPS_TENANT_ID}/oauth2/v2.0`;
const OWA_SCOPE =
  "https://outlook.office.com/Mail.Read https://outlook.office.com/Mail.Send offline_access openid profile";
const GRAPH_SCOPE =
  "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send offline_access openid profile";
const TOKEN_SKEW_S = 90;
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 10;
const MAX_SUBJECT = 200;
const MAX_BODY = 8000;

function b64urlJson(part) {
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function jwtClaims(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  const claims = b64urlJson(part);
  return claims && typeof claims === "object" ? claims : {};
}

function tokenAudience(token) {
  const aud = jwtClaims(token).aud;
  if (Array.isArray(aud)) return aud.map(String).join(" ");
  return String(aud || "");
}

function jwtExp(token) {
  const exp = Number(jwtClaims(token).exp);
  return Number.isFinite(exp) ? exp : 0;
}

function jwtEmail(token) {
  const c = jwtClaims(token);
  return String(c.preferred_username || c.upn || c.unique_name || c.email || "").trim();
}

function isMailAudience(token) {
  const aud = tokenAudience(token).toLowerCase();
  return (
    aud.includes("graph.microsoft.com") ||
    aud.includes(GRAPH_APP_ID) ||
    aud.includes("outlook.office.com") ||
    aud.includes("outlook.office365.com")
  );
}

function apiBaseForToken(token) {
  const aud = tokenAudience(token).toLowerCase();
  if (aud.includes("graph.microsoft.com") || aud.includes(GRAPH_APP_ID)) {
    return GRAPH_BASE;
  }
  return OUTLOOK_REST_BASE;
}

function redactSecrets(raw) {
  return String(raw || "")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[jwt]");
}

function oauthError(data, fallback) {
  const code = String(data?.error || "").trim();
  const desc = redactSecrets(data?.error_description || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return code || desc || fallback || "oauth failed";
}

function tokenPayload(accessToken, refreshToken = "", extra = {}) {
  return {
    ok: true,
    accessToken,
    refreshToken: refreshToken || "",
    exp: jwtExp(accessToken),
    email: jwtEmail(accessToken),
    clientId: extra.clientId || "",
    scope: extra.scope || "",
  };
}

async function readOauthJson(res) {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: redactSecrets(text).replace(/\s+/g, " ").slice(0, 160) };
  }
}

async function requestDeviceCode(clientId, scope) {
  const res = await fetch(`${LOGIN}/devicecode`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }),
  });
  const data = await readOauthJson(res);
  if (!res.ok || !data.device_code || !data.user_code) {
    return { ok: false, error: oauthError(data, `device code ${res.status}`) };
  }
  const expiresIn = Number(data.expires_in) || 900;
  return {
    ok: true,
    user_code: String(data.user_code),
    verification_uri: String(data.verification_uri || ""),
    verification_uri_complete: String(data.verification_uri_complete || ""),
    device_code: String(data.device_code),
    clientId,
    scope,
    interval: Number(data.interval) || 5,
    expiresAt: Date.now() + expiresIn * 1000,
    message: String(data.message || "").trim(),
  };
}

export function implicitAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: OUTLOOK_WEB_CLIENT_ID,
    response_type: "token",
    redirect_uri: OWA_URL,
    scope: OWA_SCOPE,
    nonce: "epsynapse-outlook",
  });
  return `${LOGIN}/authorize?${params}`;
}

export async function startDeviceCode() {
  try {
    const owa = await requestDeviceCode(OUTLOOK_WEB_CLIENT_ID, OWA_SCOPE);
    if (owa.ok) return owa;
    const graph = await requestDeviceCode(GRAPH_EXPLORER_CLIENT_ID, GRAPH_SCOPE);
    if (graph.ok) return graph;
    return {
      ok: false,
      error: owa.error || graph.error || "Microsoft would not start Outlook sign-in.",
      authorizeUrl: implicitAuthorizeUrl(),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "device code failed",
      authorizeUrl: implicitAuthorizeUrl(),
    };
  }
}

export async function pollDeviceCode(deviceCode, clientId) {
  const code = String(deviceCode || "").trim();
  const id = String(clientId || "").trim() || OUTLOOK_WEB_CLIENT_ID;
  if (!code) return { ok: false, error: "missing device_code" };
  let data;
  try {
    const res = await fetch(`${LOGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: id,
        grant_type: DEVICE_GRANT,
        device_code: code,
      }),
    });
    data = await readOauthJson(res);
    if (res.ok && data.access_token) {
      return tokenPayload(data.access_token, data.refresh_token, {
        clientId: id,
        scope: id === GRAPH_EXPLORER_CLIENT_ID ? GRAPH_SCOPE : OWA_SCOPE,
      });
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "token poll failed" };
  }
  const error = String(data?.error || "token poll failed");
  if (error === "authorization_pending" || error === "slow_down") {
    return { ok: false, pending: true, error };
  }
  return { ok: false, error: oauthError(data, error) };
}

export function acceptPastedToken(accessToken) {
  const token = String(accessToken || "").trim();
  if (!token || token.split(".").length < 2) {
    return { ok: false, error: "invalid token" };
  }
  if (!isMailAudience(token)) {
    return { ok: false, error: "token audience is not Outlook or Graph mail" };
  }
  return tokenPayload(token, "", { clientId: OUTLOOK_WEB_CLIENT_ID, scope: OWA_SCOPE });
}

export async function refreshAccessToken(refreshToken, clientId, scope) {
  const rt = String(refreshToken || "").trim();
  const id = String(clientId || "").trim() || OUTLOOK_WEB_CLIENT_ID;
  const scp = String(scope || "").trim() || OWA_SCOPE;
  if (!rt) return { ok: false, error: "no refresh token" };
  try {
    const res = await fetch(`${LOGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: id,
        grant_type: "refresh_token",
        refresh_token: rt,
        scope: scp,
      }),
    });
    const data = await readOauthJson(res);
    if (!res.ok || !data.access_token) {
      return { ok: false, error: oauthError(data, `refresh ${res.status}`) };
    }
    return tokenPayload(data.access_token, data.refresh_token || rt, {
      clientId: id,
      scope: scp,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "refresh failed" };
  }
}

export async function ensureFreshToken(outlook) {
  const access = String(outlook?.accessToken || "").trim();
  if (!access) throw new Error("not connected to Outlook");
  const exp = Number(outlook.exp) || jwtExp(access);
  if (exp * 1000 > Date.now() + TOKEN_SKEW_S * 1000) return outlook;
  const refreshed = await refreshAccessToken(
    outlook.refreshToken,
    outlook.clientId,
    outlook.scope
  );
  if (!refreshed.ok) {
    throw new Error(refreshed.error || "Outlook token expired");
  }
  return {
    ...outlook,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || outlook.refreshToken || "",
    exp: refreshed.exp,
    email: refreshed.email || outlook.email || "",
    clientId: refreshed.clientId || outlook.clientId || "",
    scope: refreshed.scope || outlook.scope || "",
  };
}

function emailAddress(raw) {
  if (!raw || typeof raw !== "object") return { name: "", address: "" };
  const inner = raw.emailAddress || raw.EmailAddress || raw;
  return {
    name: String(inner.name || inner.Name || "").trim(),
    address: String(inner.address || inner.Address || "").trim(),
  };
}

export function stripHtml(html, max = 8000) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, max);
}

export function normalizeMessage(raw, { includeBody = false } = {}) {
  const from = emailAddress(raw.from || raw.From);
  const body = raw.body || raw.Body || {};
  const html = String(body.content || body.Content || "");
  const type = String(body.contentType || body.ContentType || "").toLowerCase();
  const preview = String(raw.bodyPreview || raw.BodyPreview || "").trim();
  const toList = Array.isArray(raw.toRecipients || raw.ToRecipients)
    ? (raw.toRecipients || raw.ToRecipients).map((r) => emailAddress(r).address).filter(Boolean)
    : [];
  const out = {
    id: String(raw.id || raw.Id || ""),
    subject: String(raw.subject || raw.Subject || "(no subject)").trim(),
    from: from.address ? `${from.name} <${from.address}>`.trim() : from.name,
    fromAddress: from.address,
    to: toList.join(", "),
    received: String(raw.receivedDateTime || raw.ReceivedDateTime || ""),
    unread: !(raw.isRead ?? raw.IsRead ?? true),
    preview: preview.slice(0, 400),
    webLink: String(raw.webLink || raw.WebLink || "").trim(),
  };
  if (includeBody) {
    out.body = type.includes("text") ? html.trim().slice(0, MAX_BODY) : stripHtml(html, MAX_BODY);
  }
  return out;
}

function buildListUrl(base, { search = "", limit = 20 } = {}) {
  const top = Math.min(50, Math.max(1, Number(limit) || 20));
  if (base === GRAPH_BASE) {
    const select = "$select=id,subject,from,receivedDateTime,bodyPreview,isRead,webLink";
    if (search) {
      const q = `"${String(search).replace(/"/g, "")}"`;
      return `${base}/me/messages?$search=${encodeURIComponent(q)}&$top=${top}&${select}`;
    }
    return `${base}/me/mailFolders/Inbox/messages?$top=${top}&$orderby=receivedDateTime desc&${select}`;
  }
  const select = "$select=Id,Subject,From,ReceivedDateTime,BodyPreview,IsRead,WebLink";
  if (search) {
    const q = `"${String(search).replace(/"/g, "")}"`;
    return `${base}/me/messages?$search=${encodeURIComponent(q)}&$top=${top}&${select}`;
  }
  return `${base}/me/mailFolders/Inbox/messages?$top=${top}&$orderby=ReceivedDateTime desc&${select}`;
}

function buildReadUrl(base, id) {
  const safe = encodeURIComponent(String(id || "").trim());
  if (base === GRAPH_BASE) {
    return `${base}/me/messages/${safe}?$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,isRead,webLink`;
  }
  return `${base}/me/messages/${safe}?$select=Id,Subject,From,ToRecipients,ReceivedDateTime,BodyPreview,Body,IsRead,WebLink`;
}

async function mailRequest(token, method, url, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Prefer: 'outlook.body-content-type="text"',
  };
  let payload = body;
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(payload);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) {
    const snippet = redactSecrets(text).replace(/\s+/g, " ").slice(0, 220);
    const err = new Error(`Outlook ${res.status}: ${snippet}`);
    err.status = res.status;
    throw err;
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export async function listMessages(token, { search = "", limit = 20 } = {}) {
  const base = apiBaseForToken(token);
  const data = await mailRequest(token, "GET", buildListUrl(base, { search, limit }));
  const rows = Array.isArray(data.value) ? data.value : [];
  return rows.map((row) => normalizeMessage(row));
}

export async function readMessage(token, id) {
  const mid = String(id || "").trim();
  if (!mid) throw new Error("message id required");
  const base = apiBaseForToken(token);
  const raw = await mailRequest(token, "GET", buildReadUrl(base, mid));
  return normalizeMessage(raw, { includeBody: true });
}

export function parseRecipients(raw) {
  const parts = String(raw || "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("Add at least one To address.");
  if (parts.length > MAX_RECIPIENTS) {
    throw new Error(`At most ${MAX_RECIPIENTS} recipients.`);
  }
  for (const addr of parts) {
    if (!EMAIL_RE.test(addr)) throw new Error(`Bad email address: ${addr}`);
  }
  return parts;
}

export async function sendMessage(token, { to, subject, body } = {}) {
  const recipients = parseRecipients(to);
  const subj = String(subject || "").trim();
  const text = String(body || "").trim();
  if (!subj) throw new Error("Subject is required.");
  if (!text) throw new Error("Message body is required.");
  if (subj.length > MAX_SUBJECT) throw new Error("Subject is too long.");
  if (text.length > MAX_BODY) throw new Error("Message body is too long.");

  const base = apiBaseForToken(token);
  if (base === GRAPH_BASE) {
    await mailRequest(token, "POST", `${base}/me/sendMail`, {
      message: {
        subject: subj,
        body: { contentType: "Text", content: text },
        toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
      },
    });
  } else {
    await mailRequest(token, "POST", `${base}/me/sendmail`, {
      Message: {
        Subject: subj,
        Body: { ContentType: "Text", Content: text },
        ToRecipients: recipients.map((address) => ({ EmailAddress: { Address: address } })),
      },
    });
  }
  return { sent: true, to: recipients.join(", "), subject: subj };
}

export function publicPending(outlook) {
  const src =
    outlook?.pending && typeof outlook.pending === "object" ? outlook.pending : outlook;
  const code = String(src?.user_code || "").trim();
  const uri = String(src?.verification_uri || "").trim();
  if (!code && !uri) return null;
  if (isConnected(outlook)) return null;
  return {
    user_code: code,
    verification_uri: uri,
    message: String(src.message || "").trim(),
  };
}

export function isConnected(outlook) {
  const token = String(outlook?.accessToken || "").trim();
  if (!token) return false;
  const exp = Number(outlook.exp) || jwtExp(token);
  return exp * 1000 > Date.now();
}
