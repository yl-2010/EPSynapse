/**
 * Canvas OAuth2 (authorization code) for Eastside Prep students.
 *
 * Uses a Canvas Developer Key issued by EPS IT. Students on the "other" door keep
 * pasting a manual access token; this module answers 403 for them.
 *
 * Endpoints, from https://canvas.instructure.com/doc/api/file.oauth_endpoints.html
 *   GET    {host}/login/oauth2/auth?client_id&response_type=code&redirect_uri&state[&scope]
 *   POST   {host}/login/oauth2/token   grant_type=authorization_code | refresh_token
 *   DELETE {host}/login/oauth2/token   Authorization: Bearer <access_token>
 * Access tokens from keys issued after Oct 2015 last one hour. The refresh token does
 * not expire unless revoked, and the refresh response does not include a new one.
 *
 * Student fields this module reads and writes, all kept by students.js hydrate() and
 * sealed on disk where they are secrets:
 *   canvasHost, canvasToken
 *   canvasRefreshToken (string)
 *   canvasTokenExp (unix seconds)
 *   canvasAuthMode ("oauth" | "")
 *   canvasAuth ({ state, returnTo, createdAt } | null)   the in-flight sign-in
 * The in-memory state map is the fast path; canvasAuth on the student is the fallback
 * after a restart.
 *
 * Nothing here calls the network at import time. Env is read on each call so dotenv
 * order does not matter.
 */

import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import {
  googleFileId,
  isPaused,
  loadStudentByFileId,
  PAUSED_MESSAGE,
  saveStudent,
  studentFromRequest,
  studentsDir,
  updateStudentProfile,
} from "./students.js";
import { normalizeHost } from "./canvas.js";

const DEFAULT_HOST = "https://eastsideprep.instructure.com";
const DEFAULT_REDIRECT_URI = "https://api.epsynapse.com/v1/canvas/callback";
const DEFAULT_RETURN = "https://epsynapse.com";
const STATE_TTL_MS = 15 * 60 * 1000;
const GRANT_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_SEC = 120;
const FETCH_MS = 15_000;
/** The start route mints 32 random bytes as hex. Anything else never reaches the disk scan. */
const STATE_RE = /^[0-9a-f]{64}$/;

/** state -> { fileId, returnTo, createdAt }. The callback hop carries no cookie. */
const authStates = new Map();
/**
 * Native sign-ins: state -> { fileId, body, createdAt }. The callback exchanges the
 * code but stores nothing; the app posts the state to /v1/me/canvas/oauth/finish from
 * its own session and the token set lands there. Single use, 10 minutes.
 */
const pendingGrants = new Map();

function envStr(name, fallback = "") {
  return String(process.env[name] || "").trim() || fallback;
}

function config() {
  let host = DEFAULT_HOST;
  try {
    host = normalizeHost(envStr("CANVAS_OAUTH_HOST", DEFAULT_HOST));
  } catch {
    host = DEFAULT_HOST;
  }
  return {
    clientId: envStr("CANVAS_OAUTH_CLIENT_ID"),
    clientSecret: envStr("CANVAS_OAUTH_CLIENT_SECRET"),
    host,
    redirectUri: envStr("CANVAS_OAUTH_REDIRECT_URI", DEFAULT_REDIRECT_URI),
    scopes: envStr("CANVAS_OAUTH_SCOPES"),
  };
}

export function canvasOAuthConfigured() {
  return Boolean(config().clientId);
}

/** Same rule as index.js: 4xx keeps its message, 5xx is logged and answered generically. */
function fail(res, err, fallback = 500) {
  const status = Number(err?.status) || fallback;
  const safe = status >= 400 && status < 600 ? status : fallback;
  const message = String(err?.message || "Request failed.");
  if (safe >= 500) {
    console.error(`[canvas-oauth] ${safe} ${message}`);
    return res.status(safe).json({ error: "Something went wrong" });
  }
  return res.status(safe).json({ error: message });
}

async function requireStudent(req, res) {
  const student = await studentFromRequest(req);
  if (!student) {
    res.status(401).json({ error: "Sign in with Google first." });
    return null;
  }
  if (isPaused(student)) {
    res.status(423).json({ error: PAUSED_MESSAGE, paused: true, door: student.door });
    return null;
  }
  return student;
}

function requireEps(student, res) {
  if (student.door === "eps") return true;
  res.status(403).json({
    error: "Canvas sign-in is for Eastside Prep accounts. Paste a Canvas access token in Settings instead.",
  });
  return false;
}

/** Same allowlist as the Microsoft callback in index.js. Returns an origin or "epsynapse://". */
export function safeCanvasReturnTo(raw) {
  const s = String(raw || "").trim();
  if (!s) return DEFAULT_RETURN;
  if (/^epsynapse:\/\//i.test(s)) return "epsynapse://";
  let url;
  try {
    url = new URL(s);
  } catch {
    return DEFAULT_RETURN;
  }
  const allowed = new Set([
    "https://epsynapse.com",
    "https://www.epsynapse.com",
    "https://jype-six.vercel.app",
  ]);
  if (allowed.has(url.origin)) return url.origin;
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return url.origin;
  }
  return DEFAULT_RETURN;
}

function redirectTarget(returnTo, result, reason = "", state = "") {
  // encodeURIComponent, not URLSearchParams: iOS URLComponents does not turn "+" into a space.
  const native = returnTo === "epsynapse://";
  // Web keeps the ?canvas= key app.js reads; the native URL uses result= like epsynapse://ms.
  const parts = [`${native ? "result" : "canvas"}=${encodeURIComponent(result)}`];
  if (state) parts.push(`state=${encodeURIComponent(state)}`);
  if (reason) parts.push(`reason=${encodeURIComponent(String(reason).slice(0, 200))}`);
  if (native) return `epsynapse://canvas?${parts.join("&")}`;
  return `${returnTo}/?${parts.join("&")}`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function shortError(err) {
  return String(err?.message || err || "Canvas sign-in failed.").slice(0, 200);
}

async function tokenRequest(host, params) {
  let res;
  try {
    res = await fetch(`${host}/login/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch (err) {
    const timedOut = err && err.name === "TimeoutError";
    const e = new Error(timedOut ? "Canvas timed out." : "Could not reach Canvas.");
    e.status = 502;
    throw e;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = String(body?.error_description || body?.error || "").trim();
    const e = new Error(detail ? `Canvas: ${detail}` : `Canvas returned ${res.status}.`);
    e.status = res.status === 400 || res.status === 401 ? 401 : 502;
    e.canvasError = String(body?.error || "");
    throw e;
  }
  return body;
}

async function exchangeCode(code) {
  const cfg = config();
  return tokenRequest(cfg.host, {
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    code,
  });
}

async function refreshAccessToken(refreshToken) {
  const cfg = config();
  return tokenRequest(cfg.host, {
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    refresh_token: refreshToken,
  });
}

async function revokeToken(host, token) {
  const bearer = String(token || "").trim();
  if (!bearer) return;
  try {
    await fetch(`${host}/login/oauth2/token`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch (err) {
    console.warn("[canvas-oauth] revoke", shortError(err));
  }
}

function expFrom(body) {
  const secs = Number(body?.expires_in);
  return Number.isFinite(secs) && secs > 0 ? nowSec() + Math.floor(secs) : nowSec() + 3600;
}

/** Write the OAuth token set onto the student. One disk write. */
async function applyTokenSet(student, body, { keepRefresh = "" } = {}) {
  const cfg = config();
  student.canvasRefreshToken = String(body?.refresh_token || keepRefresh || "");
  student.canvasTokenExp = expFrom(body);
  student.canvasAuthMode = "oauth";
  student.canvasAuth = null;
  return updateStudentProfile(student, {
    canvasToken: String(body?.access_token || ""),
    canvasHost: cfg.host,
  });
}

async function clearTokenSet(student) {
  student.canvasRefreshToken = "";
  student.canvasTokenExp = 0;
  student.canvasAuthMode = "";
  student.canvasAuth = null;
  return updateStudentProfile(student, { canvasToken: "" });
}

function liveState(entry) {
  if (!entry) return null;
  const created = Date.parse(entry.createdAt || "") || 0;
  if (!created || Date.now() - created > STATE_TTL_MS) return null;
  return entry;
}

/** Disk fallback for the state map (server restart). Reads every student file, so only for a well-formed state. */
async function findStudentByCanvasAuthState(state) {
  if (!STATE_RE.test(String(state || ""))) return null;
  let names;
  try {
    names = await readdir(studentsDir());
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const student = await loadStudentByFileId(name.slice(0, -5)).catch(() => null);
    if (student?.canvasAuth?.state === state && liveState(student.canvasAuth)) return student;
  }
  return null;
}

async function resolveState(state) {
  const key = String(state || "").trim();
  if (!key) return null;
  const hit = liveState(authStates.get(key));
  if (hit?.fileId) {
    const student = await loadStudentByFileId(hit.fileId).catch(() => null);
    if (student) return { student, returnTo: hit.returnTo };
  }
  const student = await findStudentByCanvasAuthState(key);
  if (student) return { student, returnTo: student.canvasAuth?.returnTo || "" };
  return null;
}

function pruneStates() {
  for (const [key, entry] of authStates) {
    if (!liveState(entry)) authStates.delete(key);
  }
  for (const [key, entry] of pendingGrants) {
    if (Date.now() - entry.createdAt > GRANT_TTL_MS) pendingGrants.delete(key);
  }
}

/** Parked grant for a state, or null when unknown or expired. Removes it either way (single use). */
function takePendingGrant(state) {
  const key = String(state || "").trim();
  if (!STATE_RE.test(key)) return null;
  const entry = pendingGrants.get(key);
  pendingGrants.delete(key);
  if (!entry || Date.now() - entry.createdAt > GRANT_TTL_MS) return null;
  return entry;
}

/**
 * Refresh the OAuth access token when it is within 120s of expiry. No-op for manual
 * tokens. Call before Canvas reads. On refresh failure the student is returned as is
 * and the Canvas read reports the 401 the usual way.
 */
export async function ensureFreshCanvasToken(student) {
  if (!student || student.canvasAuthMode !== "oauth") return student;
  const refreshToken = String(student.canvasRefreshToken || "");
  if (!refreshToken || !canvasOAuthConfigured()) return student;
  const exp = Number(student.canvasTokenExp) || 0;
  if (exp && exp - nowSec() > REFRESH_SKEW_SEC) return student;
  try {
    const body = await refreshAccessToken(refreshToken);
    return await applyTokenSet(student, body, { keepRefresh: refreshToken });
  } catch (err) {
    console.warn("[canvas-oauth] refresh failed", shortError(err));
    return student;
  }
}

/** For the profile payload. mode: "oauth" | "manual" | "none". */
export function canvasOAuthPublic(student) {
  const hasToken = Boolean(student?.canvasToken);
  let mode = "none";
  if (hasToken) mode = student?.canvasAuthMode === "oauth" ? "oauth" : "manual";
  return { configured: canvasOAuthConfigured(), mode };
}

function buildAuthorizeUrl(state) {
  const cfg = config();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    state,
  });
  if (cfg.scopes) params.set("scope", cfg.scopes);
  return `${cfg.host}/login/oauth2/auth?${params.toString()}`;
}

export function mountCanvasOAuth(app) {
  app.post("/v1/me/canvas/oauth/start", async (req, res) => {
    try {
      if (!canvasOAuthConfigured()) {
        return res.status(503).json({
          error: "Canvas sign-in is not set up yet. The school Canvas developer key is missing.",
          configured: false,
        });
      }
      const student = await requireStudent(req, res);
      if (!student) return;
      if (!requireEps(student, res)) return;

      pruneStates();
      const state = randomBytes(32).toString("hex");
      const returnTo = safeCanvasReturnTo(req.body?.returnTo);
      const createdAt = new Date().toISOString();
      const fileId = googleFileId(student.googleSub);
      authStates.set(state, { fileId, returnTo, createdAt });

      // Survives a restart only once students.js hydrate() keeps canvasAuth.
      student.canvasAuth = { state, returnTo, createdAt };
      await saveStudent(student).catch((err) => {
        console.warn("[canvas-oauth] could not persist canvasAuth", shortError(err));
      });

      return res.json({ authorizeUrl: buildAuthorizeUrl(state) });
    } catch (err) {
      return fail(res, err);
    }
  });

  app.get("/v1/canvas/callback", async (req, res) => {
    const state = String(req.query.state || "").trim();
    const code = String(req.query.code || "").trim();
    const oauthError = String(req.query.error || "").trim();
    const oauthDesc = String(req.query.error_description || "").trim();
    let returnTo = DEFAULT_RETURN;
    let result = "error";
    let reason = "";
    let pendingState = "";
    try {
      const hit = await resolveState(state);
      if (!hit) {
        reason = "This Canvas link is stale. Start again from EPSynapse.";
      } else {
        returnTo = safeCanvasReturnTo(hit.returnTo);
        const native = returnTo === "epsynapse://";
        const fileId = googleFileId(hit.student.googleSub);

        // Bind the grant to the browser that started it, not only to the state value.
        // A session for someone else, or no session at all on the web path, fails
        // closed: nothing is exchanged or stored.
        const sessionStudent = await studentFromRequest(req).catch(() => null);
        const sessionFileId = sessionStudent ? googleFileId(sessionStudent.googleSub) : "";
        if (sessionFileId && sessionFileId !== fileId) {
          console.warn(`[canvas-oauth] callback session mismatch state-owner=${fileId} session=${sessionFileId}`);
          reason = "This Canvas link belongs to a different EPSynapse account. Start again from EPSynapse.";
        } else if (!sessionFileId && !native) {
          reason = "Sign in to EPSynapse in this browser first, then connect Canvas again.";
        } else {
          const current = (await loadStudentByFileId(fileId)) || hit.student;
          if (oauthError) {
            if (oauthError === "access_denied") {
              reason = "You declined the Canvas sign-in.";
              if (native) result = "denied";
            } else {
              reason = `${oauthError} ${oauthDesc}`.trim();
            }
            current.canvasAuth = null;
            await saveStudent(current).catch(() => {});
            console.warn(`[canvas-oauth] callback error ${oauthError} ${oauthDesc.slice(0, 160)}`);
          } else if (!code) {
            reason = "Canvas did not send a code.";
          } else {
            const body = await exchangeCode(code);
            if (!body?.access_token) {
              reason = "Canvas did not return an access token.";
            } else if (native) {
              // The app's own session posts the state to /v1/me/canvas/oauth/finish.
              pruneStates();
              pendingGrants.set(state, { fileId, body, createdAt: Date.now() });
              pendingState = state;
              result = "pending";
            } else {
              await applyTokenSet(current, body);
              result = "connected";
              console.log(`[canvas-oauth] connected ${fileId}`);
            }
          }
          authStates.delete(state);
        }
      }
    } catch (err) {
      reason = shortError(err);
      console.warn("[canvas-oauth] callback", reason);
    }
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, redirectTarget(returnTo, result, result === "error" ? reason : "", pendingState));
  });

  /**
   * Native apps finish the Canvas sign-in here from their own session. The token set
   * parked by the callback is stored exactly as the web callback would have stored it.
   * Body { state }. 200 { ok: true }. 400 { error } when the state is unknown, expired,
   * already used, or was started by another account.
   */
  app.post("/v1/me/canvas/oauth/finish", async (req, res) => {
    try {
      const student = await requireStudent(req, res);
      if (!student) return;
      if (!requireEps(student, res)) return;
      const grant = takePendingGrant(req.body?.state);
      const fileId = googleFileId(student.googleSub);
      if (!grant || grant.fileId !== fileId) {
        return res.status(400).json({ error: "That Canvas sign-in is stale or not yours. Start again from EPSynapse." });
      }
      const current = (await loadStudentByFileId(fileId)) || student;
      await applyTokenSet(current, grant.body);
      console.log(`[canvas-oauth] connected ${fileId}`);
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  });

  app.post("/v1/me/canvas/oauth/disconnect", async (req, res) => {
    try {
      const student = await requireStudent(req, res);
      if (!student) return;
      if (student.canvasAuthMode === "oauth" && student.canvasToken) {
        await revokeToken(config().host, student.canvasToken);
      }
      await clearTokenSet(student);
      const fileId = googleFileId(student.googleSub);
      authStates.forEach((entry, key) => {
        if (entry.fileId === fileId) authStates.delete(key);
      });
      pendingGrants.forEach((entry, key) => {
        if (entry.fileId === fileId) pendingGrants.delete(key);
      });
      return res.json({ ok: true });
    } catch (err) {
      return fail(res, err);
    }
  });
}
