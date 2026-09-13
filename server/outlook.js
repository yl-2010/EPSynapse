/**
 * School Outlook via Microsoft Graph.
 * Tokens come only from the authorization code + PKCE sign-in in onedrive.js
 * (EPSynapse's own app registration). This file reads and sends mail with them.
 */

import {
  GRAPH_TIMEOUT_MS,
  graphClientId,
  refreshAccessToken as refreshGraphToken,
} from "./onedrive.js";

export const EPS_TENANT_ID = "b2681e8b-dd20-46cf-b163-371a2d7c6014";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const OUTLOOK_REST_BASE = "https://outlook.office.com/api/v2.0";

export function outlookClientId() {
  return graphClientId();
}
const TOKEN_SKEW_S = 90;
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
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

export async function ensureFreshToken(outlook) {
  const access = String(outlook?.accessToken || "").trim();
  if (!access) throw new Error("not connected to Outlook");
  const exp = Number(outlook.exp) || jwtExp(access);
  if (exp * 1000 > Date.now() + TOKEN_SKEW_S * 1000) return outlook;
  const refreshed = await refreshGraphToken(outlook.refreshToken, {
    clientId: outlook.clientId,
    scope: outlook.scope,
  });
  if (!refreshed.ok) {
    throw new Error(refreshed.error || "Outlook token expired");
  }
  return {
    ...outlook,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || outlook.refreshToken || "",
    exp: refreshed.exp,
    email: refreshed.email || outlook.email || "",
    clientId: outlook.clientId || graphClientId(),
    scope: outlook.scope || "",
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
  const res = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
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

export async function listEvents(token, { days = 7 } = {}) {
  const base = apiBaseForToken(token);
  if (base !== GRAPH_BASE) return [];
  const span = Math.min(31, Math.max(1, Number(days) || 7));
  const start = new Date();
  const end = new Date(start.getTime() + span * 24 * 60 * 60 * 1000);
  const url =
    `${GRAPH_BASE}/me/calendarView` +
    `?startDateTime=${encodeURIComponent(start.toISOString())}` +
    `&endDateTime=${encodeURIComponent(end.toISOString())}` +
    `&$top=20&$orderby=start/dateTime`;
  const data = await mailRequest(token, "GET", url);
  const rows = Array.isArray(data.value) ? data.value : [];
  return rows.map((raw) => ({
    id: String(raw.id || raw.Id || ""),
    subject: String(raw.subject || raw.Subject || "(no subject)").trim(),
    start: String(raw.start?.dateTime || raw.Start?.DateTime || ""),
    end: String(raw.end?.dateTime || raw.End?.DateTime || ""),
    webLink: String(raw.webLink || raw.WebLink || "").trim(),
    location: String(
      raw.location?.displayName || raw.Location?.DisplayName || raw.location || ""
    ).trim(),
  }));
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

export function isConnected(outlook) {
  const token = String(outlook?.accessToken || "").trim();
  if (!token) return false;
  if (outlook?.denied) return false;
  const exp = Number(outlook.exp) || jwtExp(token);
  if (!exp) return true;
  return exp * 1000 > Date.now();
}
