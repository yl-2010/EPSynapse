/**
 * School Teams via Microsoft Graph device-code flow.
 * Chat scopes need Eastside Prep IT approval. adminConsentUrl() is for that step.
 */

import { completeDeviceUrl, OFFICE_CLIENT_ID } from "./onedrive.js";

export const EPS_TENANT_ID = "b2681e8b-dd20-46cf-b163-371a2d7c6014";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const LOGIN = `https://login.microsoftonline.com/${EPS_TENANT_ID}/oauth2/v2.0`;
const TEAMS_SCOPE =
  "Chat.Read Chat.ReadWrite ChatMessage.Send offline_access openid profile";

const TOKEN_SKEW_S = 90;
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const MESSAGE_TEXT_MAX = 4000;

export function teamsClientId() {
  return String(process.env.MICROSOFT_CLIENT_ID || "").trim() || OFFICE_CLIENT_ID;
}

export function adminConsentUrl() {
  const id = encodeURIComponent(teamsClientId());
  return `https://login.microsoftonline.com/${EPS_TENANT_ID}/v2.0/adminconsent?client_id=${id}&scope=https://graph.microsoft.com/.default&redirect_uri=https://epsynapse.com/`;
}

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

function jwtExp(token) {
  const exp = Number(jwtClaims(token).exp);
  return Number.isFinite(exp) ? exp : 0;
}

function jwtEmail(token) {
  const c = jwtClaims(token);
  return String(c.preferred_username || c.upn || c.unique_name || c.email || "").trim();
}

function tokenAudience(token) {
  const aud = jwtClaims(token).aud;
  if (Array.isArray(aud)) return aud.map(String).join(" ");
  return String(aud || "");
}

function isGraphAudience(token) {
  const aud = tokenAudience(token).toLowerCase();
  return aud.includes("graph.microsoft.com") || aud.includes(GRAPH_APP_ID);
}

function hasChatScope(token) {
  const scp = String(jwtClaims(token).scp || "").toLowerCase();
  if (!scp) return true;
  return /chat\.(read|readwrite)|chatmessage\.send/.test(scp);
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
    verification_uri_complete:
      String(data.verification_uri_complete || "").trim() ||
      completeDeviceUrl(data.user_code, data.verification_uri),
    device_code: String(data.device_code),
    clientId,
    scope,
    interval: Number(data.interval) || 5,
    expiresAt: Date.now() + expiresIn * 1000,
    message: String(data.message || "").trim(),
  };
}

export async function startDeviceCode() {
  try {
    const flow = await requestDeviceCode(teamsClientId(), TEAMS_SCOPE);
    if (flow.ok) return flow;
    return {
      ok: false,
      error: flow.error || "Microsoft would not start Teams sign-in.",
      adminConsentUrl: adminConsentUrl(),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "device code failed",
      adminConsentUrl: adminConsentUrl(),
    };
  }
}

export async function pollDeviceCode(deviceCode, clientId) {
  const code = String(deviceCode || "").trim();
  const id = String(clientId || "").trim() || teamsClientId();
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
        scope: TEAMS_SCOPE,
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
  if (!isGraphAudience(token)) {
    return { ok: false, error: "token audience is not Microsoft Graph" };
  }
  if (!hasChatScope(token)) {
    return { ok: false, error: "token is missing Teams chat scopes" };
  }
  return tokenPayload(token, "", { clientId: teamsClientId(), scope: TEAMS_SCOPE });
}

async function refreshAccessToken(refreshToken, clientId, scope) {
  const rt = String(refreshToken || "").trim();
  const id = String(clientId || "").trim() || teamsClientId();
  const scp = String(scope || "").trim() || TEAMS_SCOPE;
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

export async function ensureFreshToken(teams) {
  const access = String(teams?.accessToken || "").trim();
  if (!access) throw new Error("not connected to Teams");
  const exp = Number(teams.exp) || jwtExp(access);
  if (exp * 1000 > Date.now() + TOKEN_SKEW_S * 1000) return teams;
  const refreshed = await refreshAccessToken(
    teams.refreshToken,
    teams.clientId,
    teams.scope
  );
  if (!refreshed.ok) {
    throw new Error(refreshed.error || "Teams token expired");
  }
  return {
    ...teams,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || teams.refreshToken || "",
    exp: refreshed.exp,
    email: refreshed.email || teams.email || "",
    clientId: refreshed.clientId || teams.clientId || "",
    scope: refreshed.scope || teams.scope || "",
  };
}

async function graphRequest(token, method, url, body) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
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
    const err = new Error(`Teams ${res.status}: ${snippet}`);
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

export function normalizeChat(raw) {
  return {
    id: String(raw?.id || "").trim(),
    name: String(raw?.topic || raw?.displayName || "").trim() || "(unnamed chat)",
    chatType: String(raw?.chatType || "").trim(),
    updated: String(raw?.lastUpdatedDateTime || "").trim(),
  };
}

export function normalizeMessage(raw, chatId = "") {
  const fromUser = raw?.from?.user || {};
  const body = raw?.body || {};
  const text = String(body?.content || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MESSAGE_TEXT_MAX);
  return {
    id: String(raw?.id || "").trim(),
    chatId: String(chatId || raw?.chatId || "").trim(),
    from: String(fromUser.displayName || fromUser.userPrincipalName || "").trim(),
    text,
    at: String(raw?.createdDateTime || raw?.lastModifiedDateTime || "").trim(),
  };
}

export async function listChats(token, { limit = 20 } = {}) {
  const top = Math.min(50, Math.max(1, Number(limit) || 20));
  const url =
    `${GRAPH_BASE}/me/chats` +
    `?$top=${top}` +
    `&$expand=members` +
    `&$select=id,topic,chatType,lastUpdatedDateTime`;
  const data = await graphRequest(token, "GET", url);
  const rows = Array.isArray(data.value) ? data.value : [];
  return rows.map((row) => normalizeChat(row));
}

export async function listChatMessages(token, chatId, { limit = 20 } = {}) {
  const id = String(chatId || "").trim();
  if (!id) throw new Error("chat id required");
  const top = Math.min(50, Math.max(1, Number(limit) || 20));
  const url = `${GRAPH_BASE}/me/chats/${encodeURIComponent(id)}/messages?$top=${top}`;
  const data = await graphRequest(token, "GET", url);
  const rows = Array.isArray(data.value) ? data.value : [];
  return rows.map((row) => normalizeMessage(row, id));
}

function looksLikeChatId(chat) {
  const s = String(chat || "").trim();
  if (!s) return false;
  if (s.startsWith("19:")) return true;
  return s.length >= 32 && !/\s/.test(s);
}

export async function sendChatMessage(token, { chat, text } = {}) {
  const content = String(text || "").trim();
  if (!content) throw new Error("message text required");
  if (content.length > MESSAGE_TEXT_MAX) throw new Error("message is too long");

  let chatId = String(chat || "").trim();
  if (!looksLikeChatId(chatId)) {
    const needle = chatId.toLowerCase();
    const chats = await listChats(token, { limit: 50 });
    const matches = chats.filter((c) => c.name.toLowerCase() === needle);
    if (matches.length === 1) chatId = matches[0].id;
    else if (matches.length > 1) throw new Error("ambiguous chat name");
    else throw new Error("chat not found");
  }

  await graphRequest(
    token,
    "POST",
    `${GRAPH_BASE}/me/chats/${encodeURIComponent(chatId)}/messages`,
    { body: { contentType: "text", content } }
  );
  return { sent: true, chatId };
}

export function publicPending(teams) {
  const src = teams?.pending && typeof teams.pending === "object" ? teams.pending : teams;
  const code = String(src?.user_code || "").trim();
  const uri = String(src?.verification_uri || "").trim();
  if (!code && !uri) return null;
  if (isConnected(teams)) return null;
  return {
    user_code: code,
    verification_uri: uri,
    verification_uri_complete:
      String(src.verification_uri_complete || "").trim() || completeDeviceUrl(code, uri),
    message: String(src.message || "").trim(),
  };
}

export function isConnected(teams) {
  const token = String(teams?.accessToken || "").trim();
  if (!token) return false;
  const exp = Number(teams.exp) || jwtExp(token);
  if (!exp) return true;
  return exp * 1000 > Date.now();
}
