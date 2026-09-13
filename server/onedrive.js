/**
 * School Microsoft 365 via Microsoft Graph.
 *
 * One sign-in path only: authorization code + PKCE against EPSynapse's own Entra app
 * registration (MICROSOFT_CLIENT_ID). The student signs in and consents in a browser
 * and Microsoft redirects back to /v1/ms/callback. School IT approves the app once
 * through adminConsentUrl().
 *
 * There is no device-code flow, no first-party client id, and no pasted-token path.
 * Microsoft Defender treats device-code sign-ins from a script as device-code
 * phishing and disabled student accounts when EPSynapse used it. When
 * MICROSOFT_CLIENT_ID is unset, Microsoft sign-in is simply off.
 */

import { createHash, randomBytes } from "node:crypto";

export const EPS_TENANT_ID = "b2681e8b-dd20-46cf-b163-371a2d7c6014";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const WRITE_FOLDER = "EPSynapse";
export const MS_TENANT = String(process.env.MICROSOFT_TENANT || "").trim() || EPS_TENANT_ID;
export const APP_SCOPES =
  "User.Read Files.ReadWrite Notes.ReadWrite Mail.ReadWrite Mail.Send Chat.ReadWrite offline_access openid profile email";
export const ADMIN_CONSENT_REDIRECT = "https://epsynapse.com/?ms=admin-consent";
export const MS_OFF_MESSAGE =
  "Microsoft sign-in is off. EPSynapse needs its own Microsoft app registration approved by school IT before this can connect.";

const LOGIN = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0`;
/** Every outbound Microsoft call gives up after this long. */
export const GRAPH_TIMEOUT_MS = 20_000;
/** Largest OneDrive file the server will pull into memory. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** Configured client id, or "" when Microsoft sign-in is off. Never a first-party id. */
export function graphClientId() {
  return String(process.env.MICROSOFT_CLIENT_ID || "").trim();
}

export function msConfigured() {
  return graphClientId().length > 0;
}

export function msClientSecret() {
  return String(process.env.MICROSOFT_CLIENT_SECRET || "").trim();
}

/** "app" when MICROSOFT_CLIENT_ID is set, "off" otherwise. */
export function msClientMode() {
  return msConfigured() ? "app" : "off";
}

export function msScopes() {
  const override = String(process.env.MICROSOFT_SCOPES || "").trim();
  return override || APP_SCOPES;
}

/** True when a stored token bag came from the configured app registration. */
export function bagMatchesClient(bag) {
  if (!msConfigured()) return false;
  const id = String(bag?.clientId || "").trim().toLowerCase();
  return id === graphClientId().toLowerCase();
}

export function adminConsentUrl() {
  if (!msConfigured()) return "";
  const q = new URLSearchParams({
    client_id: graphClientId(),
    scope: "https://graph.microsoft.com/.default",
    redirect_uri: ADMIN_CONSENT_REDIRECT,
  });
  return `https://login.microsoftonline.com/${MS_TENANT}/v2.0/adminconsent?${q}`;
}

export function newPkcePair() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function newOauthState() {
  return randomBytes(32).toString("hex");
}

export function buildAuthorizeUrl({ state, codeChallenge, redirectUri, loginHint } = {}) {
  const q = new URLSearchParams({
    client_id: graphClientId(),
    response_type: "code",
    redirect_uri: String(redirectUri || ""),
    response_mode: "query",
    scope: msScopes(),
    state: String(state || ""),
    code_challenge: String(codeChallenge || ""),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  const hint = String(loginHint || "").trim();
  if (hint) q.set("login_hint", hint);
  return `${LOGIN}/authorize?${q}`;
}

export function needsAdminApprovalText(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("aadsts65001") ||
    t.includes("aadsts90094") ||
    t.includes("consent_required") ||
    t.includes("admin consent") ||
    t.includes("admin approval") ||
    t.includes("needs permission to access resources")
  );
}

export function userDeclinedText(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("aadsts65004") || t.includes("authorization_declined");
}

export async function exchangeAuthCode({ code, codeVerifier, redirectUri } = {}) {
  const authCode = String(code || "").trim();
  if (!authCode) return { ok: false, error: "missing code" };
  if (!msConfigured()) return { ok: false, error: "microsoft_off", errorDescription: MS_OFF_MESSAGE };
  const clientId = graphClientId();
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code: authCode,
    redirect_uri: String(redirectUri || ""),
    code_verifier: String(codeVerifier || ""),
    scope: msScopes(),
  });
  const secret = msClientSecret();
  if (secret) body.set("client_secret", secret);
  let data;
  try {
    const res = await fetch(`${LOGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    data = await readOauthJson(res);
    if (res.ok && data.access_token) {
      return {
        ...tokenPayload(data.access_token, data.refresh_token),
        clientId,
        scope: msScopes(),
      };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "token exchange failed" };
  }
  const error = String(data?.error || "token exchange failed");
  const errorDescription = redactSecrets(data?.error_description || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return {
    ok: false,
    error,
    errorDescription,
    needsAdminApproval: needsAdminApprovalText(`${error} ${errorDescription}`),
    declined: userDeclinedText(`${error} ${errorDescription}`),
  };
}

export function tokenScopes(token) {
  return String(jwtClaims(token).scp || "").toLowerCase();
}

export function tokenHasFiles(token) {
  const s = tokenScopes(token);
  if (!s) return true;
  return /files\.read|sites\.read/.test(s);
}

export function tokenHasMail(token) {
  const s = tokenScopes(token);
  if (!s) return true;
  return /mail\.read|mail\.send/.test(s);
}
const TOKEN_SKEW_S = 90;
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";

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

export function redactSecrets(raw) {
  return String(raw || "")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[jwt]");
}

function oauthError(data, fallback) {
  const code = String(data?.error || "").trim();
  const desc = redactSecrets(data?.error_description || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return code || desc || fallback || "oauth failed";
}

function tokenPayload(accessToken, refreshToken = "") {
  return {
    ok: true,
    accessToken,
    refreshToken: refreshToken || "",
    exp: jwtExp(accessToken),
    email: jwtEmail(accessToken),
  };
}

function graphUrl(urlOrPath) {
  const s = String(urlOrPath || "").trim();
  if (!s) throw new Error("missing Graph URL");
  if (/^https?:\/\//i.test(s)) return s;
  return `${GRAPH_BASE}${s.startsWith("/") ? s : `/${s}`}`;
}

function writeFolderPath(folder) {
  const f = String(folder || "").trim().replace(/\/+$/, "");
  return f === WRITE_FOLDER || f === `/${WRITE_FOLDER}`;
}

function safeUploadName(name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("file name required");
  if (/[/\\]/.test(n) || n.includes("\0")) {
    throw new Error("file name cannot contain slashes");
  }
  if (n === "." || n === "..") throw new Error("invalid file name");
  return n;
}

function mapDriveItem(raw) {
  return {
    id: String(raw?.id || "").trim(),
    name: String(raw?.name || "").trim(),
    size: Number(raw?.size) || 0,
    lastModified: String(raw?.lastModifiedDateTime || "").trim(),
    folder: Boolean(raw?.folder),
    webUrl: String(raw?.webUrl || "").trim(),
    downloadUrl: String(raw?.["@microsoft.graph.downloadUrl"] || "").trim(),
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

/**
 * Refresh only tokens that came from our own app registration. A bag with a different
 * or missing clientId is a leftover from a flow that no longer exists and is refused.
 */
export async function refreshAccessToken(refreshToken, { clientId, scope } = {}) {
  const rt = String(refreshToken || "").trim();
  if (!rt) return { ok: false, error: "no refresh token" };
  if (!msConfigured()) return { ok: false, error: MS_OFF_MESSAGE };
  const id = graphClientId();
  const given = String(clientId || "").trim().toLowerCase();
  if (given && given !== id.toLowerCase()) {
    return { ok: false, error: "This Microsoft sign-in is from an old flow. Connect again." };
  }
  const body = new URLSearchParams({
    client_id: id,
    grant_type: "refresh_token",
    refresh_token: rt,
    scope: String(scope || "").trim() || msScopes(),
  });
  const secret = msClientSecret();
  if (secret) body.set("client_secret", secret);
  try {
    const res = await fetch(`${LOGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    const data = await readOauthJson(res);
    if (!res.ok || !data.access_token) {
      return { ok: false, error: oauthError(data, `refresh ${res.status}`) };
    }
    return tokenPayload(data.access_token, data.refresh_token || rt);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "refresh failed" };
  }
}

export async function ensureFreshToken(graph) {
  const access = String(graph?.accessToken || "").trim();
  if (!access) throw new Error("not connected to OneDrive");
  const exp = Number(graph.exp) || jwtExp(access);
  if (exp * 1000 > Date.now() + TOKEN_SKEW_S * 1000) return graph;
  const refreshed = await refreshAccessToken(graph.refreshToken, {
    clientId: graph.clientId,
    scope: graph.scope,
  });
  if (!refreshed.ok) {
    throw new Error(refreshed.error || "OneDrive token expired");
  }
  return {
    ...graph,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || graph.refreshToken || "",
    exp: refreshed.exp,
    email: refreshed.email || graph.email || "",
  };
}

async function graphRequest(token, method, urlOrPath, body, contentType) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload = body;
  if (payload !== undefined && payload !== null && !Buffer.isBuffer(payload)) {
    if (typeof payload === "object") {
      headers["Content-Type"] = contentType || "application/json";
      payload = JSON.stringify(payload);
    } else {
      headers["Content-Type"] = contentType || "text/plain";
    }
  } else if (payload !== undefined && payload !== null) {
    headers["Content-Type"] = contentType || "application/octet-stream";
  }
  const res = await fetch(graphUrl(urlOrPath), {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const snippet = redactSecrets(text).replace(/\s+/g, " ").slice(0, 220);
    const err = new Error(`Graph ${res.status}: ${snippet}`);
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

export async function graphGet(token, urlOrPath) {
  return graphRequest(token, "GET", urlOrPath);
}

export async function graphPut(token, urlOrPath, body, contentType) {
  return graphRequest(token, "PUT", urlOrPath, body, contentType);
}

export async function listFiles(token, { folder } = {}) {
  const path = writeFolderPath(folder)
    ? `/me/drive/root:/${WRITE_FOLDER}:/children`
    : "/me/drive/root/children";
  try {
    const data = await graphGet(token, path);
    const rows = Array.isArray(data.value) ? data.value : [];
    return rows.map(mapDriveItem);
  } catch (err) {
    if (writeFolderPath(folder) && Number(err?.status) === 404) return [];
    throw err;
  }
}

function shortProbeError(err) {
  return String(err?.message || "Graph failed")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function tagOnedrive(item) {
  return { ...item, source: "onedrive" };
}

function dedupeDriveItems(rows) {
  const byId = new Set();
  const byName = new Set();
  const out = [];
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    const name = String(row?.name || "").trim();
    if (id && byId.has(id)) continue;
    if (name && byName.has(name)) continue;
    if (id) byId.add(id);
    if (name) byName.add(name);
    out.push(row);
  }
  return out;
}

function graphErrorCode(err) {
  const m = /"code"\s*:\s*"([A-Za-z0-9_.-]+)"/.exec(String(err?.message || ""));
  return m ? m[1] : "";
}

/** Continuous Access Evaluation pulled the token for this service. A fresh sign-in fixes it. */
export function needsReauth(err) {
  const msg = String(err?.message || "");
  return /claims required|ConditionalAccess|InvalidAuthenticationToken.*expired/i.test(msg);
}

/** "401 denied (accessDenied)", "401 reauth", "500 unavailable", "404 not found". Never the token. */
export function probeErrorText(err) {
  const status = Number(err?.status) || 0;
  let label = "failed";
  if (needsReauth(err)) label = "reauth";
  else if (status === 401 || status === 403) label = "denied";
  else if (status >= 500) label = "unavailable";
  else if (status === 404) label = "not found";
  else if (status === 429) label = "rate limited";
  const code = graphErrorCode(err);
  const head = status ? `${status} ${label}` : label;
  if (code) return `${head} (${code})`;
  if (!status) return `${label}: ${shortProbeError(err).slice(0, 80)}`;
  return head;
}

export function probeDenied(text) {
  return /\bdenied\b/i.test(String(text || ""));
}

export function probeReauth(text) {
  return /\breauth\b/i.test(String(text || ""));
}

export function tokenHasNotesRead(token) {
  const s = tokenScopes(token);
  if (!s) return true;
  return /notes\.read/.test(s);
}

/**
 * One call per service, in parallel. files/notes/mail/chats are true only when Graph
 * answered 2xx. out.errors holds a short per-service reason when it did not.
 */
export async function probeGraph(token) {
  const out = {
    user: false,
    files: false,
    notes: false,
    mail: false,
    chats: false,
    calendar: false,
    email: "",
    error: "",
    errors: {},
  };
  const jobs = [
    ["user", "/me?$select=userPrincipalName,mail,displayName"],
    ["files", "/me/drive/root?$select=id"],
    ["notes", "/me/onenote/notebooks?$top=1&$select=id"],
    ["mail", "/me/mailFolders/Inbox?$select=id"],
    ["chats", "/me/chats?$top=1&$select=id"],
    ["calendar", "/me/calendar?$select=id"],
  ];
  const results = await Promise.allSettled(
    jobs.map(([, path]) => graphGet(token, path))
  );
  // /me/chats answers 401 "Unauthorized" now and then for a token that works a second
  // later. One retry for that and for 5xx keeps a flake from being recorded as denial.
  const flaky = (r) => {
    if (r.status !== "rejected") return false;
    if (needsReauth(r.reason)) return false;
    const status = Number(r.reason?.status) || 0;
    return status >= 500 || (status === 401 && graphErrorCode(r.reason) === "Unauthorized");
  };
  const retry = [];
  for (let i = 0; i < jobs.length; i += 1) if (flaky(results[i])) retry.push(i);
  if (retry.length) {
    await new Promise((r) => setTimeout(r, 700));
    for (const i of retry) {
      results[i] = (await Promise.allSettled([graphGet(token, jobs[i][1])]))[0];
    }
  }
  for (let i = 0; i < jobs.length; i += 1) {
    const [key] = jobs[i];
    const result = results[i];
    if (result.status === "fulfilled") {
      out[key] = true;
      if (key === "user") {
        const me = result.value || {};
        out.email = String(me.mail || me.userPrincipalName || "").trim();
      }
      continue;
    }
    const text = probeErrorText(result.reason);
    if (key !== "user" && key !== "calendar") out.errors[key] = text;
    if (!out.error) out.error = shortProbeError(result.reason);
  }
  if (!out.notes && !out.errors.notes) out.errors.notes = "no answer";
  if (!out.notes && !tokenHasNotesRead(token)) {
    out.errors.notes = `${out.errors.notes} (token has no Notes.Read scope)`;
  }
  return out;
}

export async function listRecentFiles(token) {
  try {
    const data = await graphGet(token, "/me/drive/recent");
    const rows = Array.isArray(data.value) ? data.value : [];
    return rows.map(mapDriveItem);
  } catch (err) {
    const status = Number(err?.status);
    if (status === 404 || status === 400) {
      const data = await graphGet(token, "/me/drive/root/children");
      const rows = Array.isArray(data.value) ? data.value : [];
      return rows.map(mapDriveItem);
    }
    throw err;
  }
}

export async function listDashboardFiles(token, { folder } = {}) {
  let recent = [];
  try {
    recent = await listRecentFiles(token);
  } catch {
    recent = [];
  }
  let folderFiles = [];
  try {
    folderFiles = await listFiles(token, { folder: folder || WRITE_FOLDER });
  } catch {
    folderFiles = [];
  }
  return dedupeDriveItems([...recent, ...folderFiles].map(tagOnedrive));
}

export async function searchFiles(token, q) {
  const query = String(q || "").trim();
  if (!query) return [];
  const safe = query.replace(/'/g, "''").slice(0, 80);
  const path = `/me/drive/root/search(q='${encodeURIComponent(safe)}')?$top=20`;
  const data = await graphGet(token, path);
  const rows = Array.isArray(data.value) ? data.value : [];
  return rows.map((raw) => tagOnedrive(mapDriveItem(raw)));
}

export async function ensureWriteFolder(token) {
  try {
    return mapDriveItem(await graphGet(token, `/me/drive/root:/${WRITE_FOLDER}`));
  } catch (err) {
    if (Number(err?.status) !== 404) throw err;
  }
  try {
    return mapDriveItem(
      await graphRequest(token, "POST", "/me/drive/root/children", {
        name: WRITE_FOLDER,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      })
    );
  } catch (err) {
    if (Number(err?.status) !== 409) throw err;
    return mapDriveItem(await graphGet(token, `/me/drive/root:/${WRITE_FOLDER}`));
  }
}

function tooLargeError() {
  const mb = Math.round(MAX_DOWNLOAD_BYTES / (1024 * 1024));
  const err = new Error(`That file is over ${mb} MB. Open it in OneDrive instead.`);
  err.status = 413;
  return err;
}

/**
 * Read a response body into memory, stopping as soon as it passes
 * MAX_DOWNLOAD_BYTES. Graph does not always send Content-Length for
 * downloads, so the size check on the metadata call is not enough on its own.
 */
async function readBodyCapped(res, limit = MAX_DOWNLOAD_BYTES) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    throw tooLargeError();
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw tooLargeError();
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

export async function downloadFile(token, itemId) {
  const id = encodeURIComponent(String(itemId || "").trim());
  if (!id) throw new Error("item id required");
  const meta = await graphGet(token, `/me/drive/items/${id}?$select=name,size`);
  const size = Number(meta.size);
  if (Number.isFinite(size) && size > MAX_DOWNLOAD_BYTES) throw tooLargeError();
  const res = await fetch(graphUrl(`/me/drive/items/${id}/content`), {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const snippet = redactSecrets(await res.text()).replace(/\s+/g, " ").slice(0, 220);
    const err = new Error(`Graph ${res.status}: ${snippet}`);
    err.status = res.status;
    throw err;
  }
  return {
    name: String(meta.name || "").trim(),
    contentType: String(res.headers.get("content-type") || "application/octet-stream"),
    buffer: await readBodyCapped(res),
  };
}

export async function uploadFile(token, { name, content, contentType } = {}) {
  const safe = safeUploadName(name);
  if (content === undefined || content === null) throw new Error("file content required");
  await ensureWriteFolder(token);
  const path = `/me/drive/root:/${WRITE_FOLDER}/${encodeURIComponent(safe)}:/content`;
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const item = await graphPut(
    token,
    path,
    body,
    contentType || "application/octet-stream"
  );
  return {
    id: String(item.id || "").trim(),
    name: String(item.name || safe).trim(),
    webUrl: String(item.webUrl || "").trim(),
    size: Number(item.size) || body.length,
  };
}

/** Token present and not expired. Ignores the denied flag. */
export function hasLiveToken(graph) {
  const token = String(graph?.accessToken || "").trim();
  if (!token) return false;
  const exp = Number(graph.exp) || jwtExp(token);
  if (!exp) return true;
  return exp * 1000 > Date.now();
}

/** Live token and Graph did not deny the service this bag is for. */
export function isConnected(graph) {
  if (!hasLiveToken(graph)) return false;
  return !graph?.denied;
}
