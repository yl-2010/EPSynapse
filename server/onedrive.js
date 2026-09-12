/**
 * School OneDrive via Microsoft Graph.
 * Microsoft Office is already on the school tenant. Graph Explorer asks for
 * new Files/Mail consent and Eastside Prep blocks that behind admin approval.
 * Override with MICROSOFT_CLIENT_ID if we later register EPSynapse itself.
 */

export const OFFICE_CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c";
export const EPS_TENANT_ID = "b2681e8b-dd20-46cf-b163-371a2d7c6014";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const WRITE_FOLDER = "EPSynapse";

const LOGIN = `https://login.microsoftonline.com/${EPS_TENANT_ID}/oauth2/v2.0`;
const DEVICE_SCOPE =
  "https://graph.microsoft.com/.default offline_access openid profile";

export function graphClientId() {
  return String(process.env.MICROSOFT_CLIENT_ID || "").trim() || OFFICE_CLIENT_ID;
}

export function completeDeviceUrl(userCode, uri) {
  const code = String(userCode || "").trim();
  if (code) return `https://login.microsoft.com/device?otc=${encodeURIComponent(code)}`;
  return String(uri || "https://login.microsoft.com/device").trim();
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
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

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

function isGraphAudience(token) {
  const aud = tokenAudience(token).toLowerCase();
  return aud.includes("graph.microsoft.com") || aud.includes(GRAPH_APP_ID);
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
    .slice(0, 160);
  return code || desc || fallback || "oauth failed";
}

function pasteFallback(error) {
  return {
    ok: false,
    error: String(error || "Microsoft blocked this sign-in."),
    pasteToken: false,
  };
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

export async function startDeviceCode() {
  const clientId = graphClientId();
  try {
    const res = await fetch(`${LOGIN}/devicecode`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        scope: DEVICE_SCOPE,
      }),
    });
    const data = await readOauthJson(res);
    if (!res.ok || !data.device_code || !data.user_code) {
      return pasteFallback(oauthError(data, `device code ${res.status}`));
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
      interval: Number(data.interval) || 5,
      expiresAt: Date.now() + expiresIn * 1000,
      message: String(data.message || "").trim(),
    };
  } catch (err) {
    return pasteFallback(err instanceof Error ? err.message : "device code failed");
  }
}

export async function pollDeviceCode(deviceCode, clientId) {
  const code = String(deviceCode || "").trim();
  if (!code) return pasteFallback("missing device_code");
  const id = String(clientId || "").trim() || graphClientId();
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
      return tokenPayload(data.access_token, data.refresh_token);
    }
  } catch (err) {
    return pasteFallback(err instanceof Error ? err.message : "token poll failed");
  }
  const error = String(data?.error || "token poll failed");
  if (error === "authorization_pending" || error === "slow_down") {
    return { ok: false, pending: true, error };
  }
  return pasteFallback(oauthError(data, error));
}

export function acceptPastedToken(accessToken) {
  const token = String(accessToken || "").trim();
  if (!token || token.split(".").length < 2) {
    return { ok: false, error: "invalid token" };
  }
  if (!isGraphAudience(token)) {
    return { ok: false, error: "token audience is not Graph" };
  }
  return tokenPayload(token, "");
}

export async function refreshAccessToken(refreshToken) {
  const rt = String(refreshToken || "").trim();
  if (!rt) return { ok: false, error: "no refresh token" };
  try {
    const res = await fetch(`${LOGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: graphClientId(),
        grant_type: "refresh_token",
        refresh_token: rt,
        scope: DEVICE_SCOPE,
      }),
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
  const refreshed = await refreshAccessToken(graph.refreshToken);
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
  const res = await fetch(graphUrl(urlOrPath), { method, headers, body: payload });
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

export async function probeGraph(token) {
  const out = {
    user: false,
    files: false,
    mail: false,
    calendar: false,
    email: "",
    error: "",
  };
  const jobs = [
    ["user", "/me?$select=userPrincipalName,mail,displayName"],
    ["files", "/me/drive/root?$select=id"],
    ["mail", "/me/mailFolders/Inbox?$select=id"],
    ["calendar", "/me/calendar?$select=id"],
  ];
  const results = await Promise.allSettled(
    jobs.map(([, path]) => graphGet(token, path))
  );
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
    if (!out.error) out.error = shortProbeError(result.reason);
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

export async function downloadFile(token, itemId) {
  const id = encodeURIComponent(String(itemId || "").trim());
  if (!id) throw new Error("item id required");
  const meta = await graphGet(token, `/me/drive/items/${id}?$select=name`);
  const res = await fetch(graphUrl(`/me/drive/items/${id}/content`), {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
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
    buffer: Buffer.from(await res.arrayBuffer()),
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

export function publicPending(graph) {
  const src =
    graph?.pending && typeof graph.pending === "object" ? graph.pending : graph;
  const code = String(src?.user_code || "").trim();
  const uri = String(src?.verification_uri || "").trim();
  if (!code && !uri) return null;
  if (isConnected(graph)) return null;
  return {
    user_code: code,
    verification_uri: uri,
    verification_uri_complete:
      String(src.verification_uri_complete || "").trim() || completeDeviceUrl(code, uri),
    message: String(src.message || "").trim(),
  };
}

export function isConnected(graph) {
  const token = String(graph?.accessToken || "").trim();
  if (!token) return false;
  const exp = Number(graph.exp) || jwtExp(token);
  if (!exp) return true;
  return exp * 1000 > Date.now();
}
