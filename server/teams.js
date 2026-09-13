/**
 * School Teams via Microsoft Graph.
 * Tokens come only from the authorization code + PKCE sign-in in onedrive.js
 * (EPSynapse's own app registration). Chat scopes need Eastside Prep IT approval;
 * adminConsentUrl() is for that step.
 */

import {
  GRAPH_TIMEOUT_MS,
  adminConsentUrl,
  graphClientId,
  refreshAccessToken as refreshGraphToken,
} from "./onedrive.js";

export { adminConsentUrl };

export const EPS_TENANT_ID = "b2681e8b-dd20-46cf-b163-371a2d7c6014";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

const TOKEN_SKEW_S = 90;
const MESSAGE_TEXT_MAX = 4000;

export function teamsClientId() {
  return graphClientId();
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

function redactSecrets(raw) {
  return String(raw || "")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[jwt]");
}

export async function ensureFreshToken(teams) {
  const access = String(teams?.accessToken || "").trim();
  if (!access) throw new Error("not connected to Teams");
  const exp = Number(teams.exp) || jwtExp(access);
  if (exp * 1000 > Date.now() + TOKEN_SKEW_S * 1000) return teams;
  const refreshed = await refreshGraphToken(teams.refreshToken, {
    clientId: teams.clientId,
    scope: teams.scope,
  });
  if (!refreshed.ok) {
    throw new Error(refreshed.error || "Teams token expired");
  }
  return {
    ...teams,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || teams.refreshToken || "",
    exp: refreshed.exp,
    email: refreshed.email || teams.email || "",
    clientId: teams.clientId || graphClientId(),
    scope: teams.scope || "",
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
  const res = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
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

export function isConnected(teams) {
  const token = String(teams?.accessToken || "").trim();
  if (!token) return false;
  if (teams?.denied) return false;
  const exp = Number(teams.exp) || jwtExp(token);
  if (!exp) return true;
  return exp * 1000 > Date.now();
}
