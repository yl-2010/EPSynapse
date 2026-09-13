/**
 * Google-account student profiles and session cookies.
 * File id is google__{sub}. School + student ID are optional settings.
 * Tokens and the model key stay on disk, never the raw secret in publicProfile().
 *
 * Secrets (Canvas tokens, model keys, Graph tokens, the PKCE verifier) are sealed with
 * crypto.js before putDoc and opened in hydrate(), so every reader sees plaintext and
 * every writer stores enc:v1:... when DATA_ENCRYPTION_KEY is set.
 *
 * Sessions are one doc each: sessions/<sid> = { studentId, createdAt, lastSeenAt }.
 * The in-memory Map is only a cache; a miss falls back to the doc so a restart or a
 * second App Engine instance still recognises the cookie.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SECRET_KEY_ERROR, encryptionEnabled, isSealed, openSecret, sealSecret } from "./crypto.js";
import { dataRoot, deleteDoc, getDoc, listDocs, listIds, putDoc } from "./store.js";

const STUDENTS = "students";
const SESSIONS = "sessions";
/** Pre-2026 layout: every session in one doc (data/sessions.json). Migrated at boot. */
const LEGACY_SESSIONS_DOC = "all";
const SESSION_ID_RE = /^[a-f0-9]{32,128}$/;
const LAST_SEEN_WRITE_MS = 60 * 60 * 1000;

export const COOKIE = "epsynapse_sid";
export const HEADER = "x-epsynapse-session";

/**
 * Which front door the student came through.
 * - "eps": Eastside Prep student. Signs in with the school Microsoft account, gets
 *   the four11 schedule and the Microsoft apps in the sign-in flow. Not live yet.
 * - "other": any other student. Google sign-in, uploads a schedule PDF, brings own keys.
 */
export const DOORS = new Set(["eps", "other"]);
export const DEFAULT_DOOR = "other";
export const PAUSED_MESSAGE =
  "EPSynapse for Eastside Prep is almost ready. Your account is paused while the school Microsoft sign-in, four11 schedule, and Canvas connection get set up. You'll sign in with your @eastsideprep.org account once it's live.";

/** Canvas host for the EPS door. Other-door students type their own; their default is "". */
const DEFAULT_CANVAS_HOST = "https://eastsideprep.instructure.com";
export const EPS_CANVAS_HOST = DEFAULT_CANVAS_HOST;
const MAX_LEN = 80;
const SESSION_MAX_AGE = 2592000;
const SKEW_SEC = 90;
const ID_CHARS = /^[A-Za-z0-9._@+\- ]+$/;
const PROVIDER_IDS = new Set(["groq", "gemini", "openrouter"]);
const MODEL_KEY_MAX = 256;
const MODEL_KEY_LIMIT = 8;

const sessions = new Map();
const sessionsReady = migrateLegacySessions();
let writeChain = sessionsReady;

function defaultCanvasHost(door) {
  return door === "eps" ? DEFAULT_CANVAS_HOST : "";
}

/** Files-mode directory of student JSON (server/data/students). Meaningless under Firestore. */
export function studentsDir() {
  return join(dataRoot(), STUDENTS);
}

function emptyGraph() {
  return {
    accessToken: "",
    refreshToken: "",
    exp: 0,
    email: "",
    pending: null,
    clientId: "",
    scope: "",
    denied: false,
  };
}

/**
 * Result of the last per-service Graph probe. Not secret.
 * files/notes/mail/chats: true, false, or null when never checked.
 */
export function emptyMsServices() {
  return {
    email: "",
    files: null,
    notes: null,
    mail: null,
    chats: null,
    errors: {},
    needsAdminApproval: false,
    checkedAt: "",
  };
}

function triState(v) {
  if (v === true || v === false) return v;
  return null;
}

function hydrateMsServices(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const errors = {};
  if (src.errors && typeof src.errors === "object") {
    for (const key of ["files", "notes", "mail", "chats"]) {
      if (src.errors[key]) errors[key] = String(src.errors[key]).slice(0, 200);
    }
  }
  return {
    email: String(src.email || ""),
    files: triState(src.files),
    notes: triState(src.notes),
    mail: triState(src.mail),
    chats: triState(src.chats),
    errors,
    needsAdminApproval: Boolean(src.needsAdminApproval),
    checkedAt: String(src.checkedAt || ""),
  };
}

function hydrateMsAuth(raw) {
  if (!raw || typeof raw !== "object" || !raw.state) return null;
  return {
    state: String(raw.state || ""),
    codeVerifier: openSecret(raw.codeVerifier || ""),
    service: String(raw.service || ""),
    returnTo: String(raw.returnTo || ""),
    authorizeUrl: String(raw.authorizeUrl || ""),
    createdAt: String(raw.createdAt || ""),
  };
}

function emptyOutlook() {
  return {
    accessToken: "",
    refreshToken: "",
    exp: 0,
    email: "",
    pending: null,
    clientId: "",
    scope: "",
  };
}

function emptyTeams() {
  return {
    accessToken: "",
    refreshToken: "",
    exp: 0,
    email: "",
    pending: null,
    clientId: "",
    scope: "",
  };
}

export function normalizeDoor(raw) {
  const door = String(raw || "").trim().toLowerCase();
  return DOORS.has(door) ? door : DEFAULT_DOOR;
}

export function isPaused(student) {
  return Boolean(student?.paused);
}

export function normalizeSchool(raw) {
  const school = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!school) return "";
  if (school.length > MAX_LEN) throw new Error("School is too long.");
  if (/[/\\\0]/.test(school)) throw new Error("Invalid school.");
  return school;
}

export function normalizeModelProvider(raw) {
  const id = String(raw || "")
    .trim()
    .toLowerCase();
  return PROVIDER_IDS.has(id) ? id : "groq";
}

export function normalizeModelKey(raw) {
  const key = String(raw ?? "").trim();
  if (key.length > MODEL_KEY_MAX) throw new Error("API key is too long.");
  return key;
}

export function normalizeModelKeys(keys, legacy) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    let key = "";
    try {
      key = normalizeModelKey(raw);
    } catch {
      return;
    }
    if (!key || seen.has(key) || out.length >= MODEL_KEY_LIMIT) return;
    seen.add(key);
    out.push(key);
  };
  if (Array.isArray(keys)) keys.forEach(add);
  add(legacy);
  return out;
}

export function studentModelKeys(student) {
  return normalizeModelKeys(student?.modelKeys, student?.modelKey);
}

function modelKeyHint(key) {
  const raw = String(key || "");
  return raw.length >= 4 ? raw.slice(-4) : "";
}

export function normalizeStudentId(raw) {
  const id = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!id) return "";
  if (id.length > MAX_LEN) throw new Error("Student id is too long.");
  if (!ID_CHARS.test(id)) throw new Error("Invalid student id.");
  return id;
}

function slugPart(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Invalid school or student id.");
  return slug;
}

export function safeFileId(school, studentId) {
  return `${slugPart(normalizeSchool(school))}__${slugPart(normalizeStudentId(studentId))}`;
}

export function googleFileId(googleSub) {
  return `google__${slugPart(String(googleSub || "").trim())}`;
}

function assertFileId(fileId) {
  const id = String(fileId ?? "").trim();
  if (
    !id ||
    id.length > 180 ||
    id.includes("..") ||
    !/^[a-z0-9._-]+__[a-z0-9._-]+$/.test(id)
  ) {
    throw new Error("Invalid student file id.");
  }
  return id;
}

function openKeys(keys) {
  return Array.isArray(keys) ? keys.map((k) => openSecret(k)) : keys;
}

function sealKeys(keys) {
  return Array.isArray(keys) ? keys.map((k) => sealSecret(k)).filter(Boolean) : [];
}

function hydrateTokenBag(bag) {
  return {
    accessToken: openSecret(bag.accessToken || ""),
    refreshToken: openSecret(bag.refreshToken || ""),
    exp: Number(bag.exp) || 0,
    email: String(bag.email || ""),
    pending: bag.pending ?? null,
    clientId: String(bag.clientId || ""),
    scope: String(bag.scope || ""),
    denied: Boolean(bag.denied),
  };
}

/**
 * Raw doc (or any student-shaped object) -> full plaintext student. Every reader goes
 * through here, so sealed fields are opened exactly once. Plaintext legacy values pass
 * through openSecret untouched; the next save seals them.
 */
function hydrate(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const graph = src.graph && typeof src.graph === "object" ? src.graph : {};
  const outlook = src.outlook && typeof src.outlook === "object" ? src.outlook : {};
  const teams = src.teams && typeof src.teams === "object" ? src.teams : {};
  const modelKeys = normalizeModelKeys(openKeys(src.modelKeys), openSecret(src.modelKey || ""));
  const door = normalizeDoor(src.door);
  return {
    googleSub: String(src.googleSub || ""),
    email: String(src.email || ""),
    googleName: String(src.googleName || ""),
    picture: String(src.picture || ""),
    rosterName: String(src.rosterName || ""),
    rosterMatched: Boolean(src.rosterMatched),
    door,
    paused: Boolean(src.paused),
    school: String(src.school || ""),
    studentId: String(src.studentId || ""),
    canvasHost: String(src.canvasHost || defaultCanvasHost(door)),
    canvasToken: openSecret(src.canvasToken || ""),
    // Canvas OAuth (EPS door, canvas-oauth.js). Empty for a pasted manual token.
    canvasRefreshToken: openSecret(src.canvasRefreshToken || ""),
    canvasTokenExp: Number(src.canvasTokenExp) || 0,
    canvasAuthMode: src.canvasAuthMode === "oauth" ? "oauth" : "",
    canvasAuth: src.canvasAuth?.state
      ? {
          state: String(src.canvasAuth.state),
          returnTo: String(src.canvasAuth.returnTo || ""),
          createdAt: String(src.canvasAuth.createdAt || ""),
        }
      : null,
    modelKeys,
    modelKey: modelKeys[0] || "",
    modelProvider: normalizeModelProvider(src.modelProvider),
    displayName: String(src.displayName || ""),
    graph: hydrateTokenBag(graph),
    outlook: hydrateTokenBag(outlook),
    teams: hydrateTokenBag(teams),
    msServices: hydrateMsServices(src.msServices),
    msAuth: hydrateMsAuth(src.msAuth),
    msConsentRequestedAt: String(src.msConsentRequestedAt || ""),
    createdAt: String(src.createdAt || ""),
    updatedAt: String(src.updatedAt || ""),
  };
}

/** Secret fields sealed for putDoc. Input is a hydrated (plaintext) student. Never mutates it. */
function toDisk(student) {
  const s = hydrate(student);
  const bag = (b) => ({ ...b, accessToken: sealSecret(b.accessToken), refreshToken: sealSecret(b.refreshToken) });
  return {
    ...s,
    canvasToken: sealSecret(s.canvasToken),
    canvasRefreshToken: sealSecret(s.canvasRefreshToken),
    modelKeys: sealKeys(s.modelKeys),
    modelKey: sealSecret(s.modelKey),
    graph: bag(s.graph),
    outlook: bag(s.outlook),
    teams: bag(s.teams),
    msAuth: s.msAuth ? { ...s.msAuth, codeVerifier: sealSecret(s.msAuth.codeVerifier) } : null,
  };
}

/** True when a raw doc still has at least one non-empty secret in plaintext. */
function hasPlaintextSecret(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const plain = (v) => Boolean(v) && !isSealed(String(v));
  if (plain(src.canvasToken) || plain(src.canvasRefreshToken) || plain(src.modelKey)) return true;
  if (Array.isArray(src.modelKeys) && src.modelKeys.some(plain)) return true;
  for (const name of ["graph", "outlook", "teams"]) {
    const bag = src[name];
    if (bag && typeof bag === "object" && (plain(bag.accessToken) || plain(bag.refreshToken))) return true;
  }
  if (src.msAuth && typeof src.msAuth === "object" && plain(src.msAuth.codeVerifier)) return true;
  return false;
}

function graphConnected(graph) {
  if (!graph?.accessToken) return false;
  if (graph.denied) return false;
  const exp = Number(graph.exp) || 0;
  if (!exp) return true;
  return exp > Math.floor(Date.now() / 1000) - SKEW_SEC;
}

/**
 * Per-bag pending state is always null now. The only sign-in is the auth-code redirect,
 * which lives in student.msAuth and is reported by the status routes as appPending.
 */
function publicPending() {
  return null;
}

export function publicProfile(student) {
  const s = hydrate(student);
  return {
    email: s.email,
    googleName: s.googleName,
    picture: s.picture,
    door: s.door,
    paused: s.paused,
    pausedMessage: s.paused ? PAUSED_MESSAGE : "",
    school: s.school,
    studentId: s.studentId,
    rosterName: s.rosterName,
    rosterMatched: s.rosterMatched,
    canvasHost: s.canvasHost,
    displayName: s.displayName,
    canvasConnected: Boolean(s.canvasToken),
    // Field kept for clients; the Cursor demo path is gone.
    cursorAgent: false,
    modelKeySet: s.modelKeys.length > 0,
    modelProvider: s.modelProvider || "groq",
    modelKeyHint: modelKeyHint(s.modelKeys[0] || s.modelKey),
    modelKeyHints: s.modelKeys.map(modelKeyHint),
    modelKeyCount: s.modelKeys.length,
    onedriveConnected: graphConnected(s.graph),
    onedriveEmail: s.graph.email || "",
    onedrivePending: publicPending(s.graph.pending),
    outlookConnected: graphConnected(s.outlook),
    outlookEmail: s.outlook.email || "",
    outlookPending: publicPending(s.outlook.pending),
    teamsConnected: graphConnected(s.teams),
    teamsEmail: s.teams.email || "",
    teamsPending: publicPending(s.teams.pending),
  };
}

/** The only writer. Seals secrets on the way out. */
async function writeStudent(fileId, data) {
  await putDoc(STUDENTS, assertFileId(fileId), toDisk(data));
}

/**
 * Re-save one student so plaintext secrets get sealed. Used by tools/reseal-students.mjs.
 * Returns { needed, sealed }. With dryRun nothing is written.
 */
export async function resealStudentFile(fileId, { dryRun = false } = {}) {
  const id = assertFileId(fileId);
  const raw = await getDoc(STUDENTS, id);
  if (!raw) return { needed: false, sealed: false };
  const needed = hasPlaintextSecret(raw);
  if (!needed || dryRun || !encryptionEnabled()) return { needed, sealed: false };
  await writeStudent(id, raw);
  return { needed: true, sealed: true };
}

/** Every student file id on disk (or in Firestore). Skips names that are not valid ids. */
async function listStudentFileIds() {
  let ids;
  try {
    ids = await listIds(STUDENTS);
  } catch {
    return null;
  }
  return ids.filter((id) => {
    try {
      assertFileId(id);
      return true;
    } catch {
      return false;
    }
  });
}

export async function loadStudentByFileId(fileId) {
  let id;
  try {
    id = assertFileId(fileId);
  } catch {
    return null;
  }
  const raw = await getDoc(STUDENTS, id);
  return raw ? hydrate(raw) : null;
}

export async function loadStudent(school, studentId) {
  return loadStudentByFileId(safeFileId(school, studentId));
}

export async function saveStudent(student) {
  const s = hydrate(student);
  if (!s.googleSub) throw new Error("Google account is required.");
  s.school = normalizeSchool(s.school);
  s.studentId = normalizeStudentId(s.studentId);
  if (!s.createdAt) s.createdAt = new Date().toISOString();
  if (!s.updatedAt) s.updatedAt = s.createdAt;
  await writeStudent(googleFileId(s.googleSub), s);
  return s;
}

export async function loadStudentByGoogleSub(sub) {
  try {
    return await loadStudentByFileId(googleFileId(sub));
  } catch (err) {
    // A wrong or missing DATA_ENCRYPTION_KEY must not look like "no account": upsert
    // would then overwrite the real doc with a blank one and drop every stored token.
    if (err?.code === SECRET_KEY_ERROR) throw err;
    return null;
  }
}

export async function upsertGoogleStudent({ googleSub, email, googleName, picture }) {
  const sub = String(googleSub ?? "").trim();
  if (!sub) throw new Error("Google account is missing.");
  const now = new Date().toISOString();
  const existing = await loadStudentByGoogleSub(sub);
  const student = existing ?? {
    googleSub: sub,
    email: "",
    googleName: "",
    picture: "",
    rosterName: "",
    rosterMatched: false,
    door: DEFAULT_DOOR,
    paused: false,
    school: "",
    studentId: "",
    canvasHost: defaultCanvasHost(DEFAULT_DOOR),
    canvasToken: "",
    modelKeys: [],
    modelKey: "",
    modelProvider: "groq",
    displayName: "",
    graph: emptyGraph(),
    outlook: emptyOutlook(),
    teams: emptyTeams(),
    createdAt: now,
    updatedAt: now,
  };
  student.googleSub = sub;
  student.email = String(email || "").trim();
  student.googleName = String(googleName || "").trim();
  student.picture = String(picture || "").trim();
  if (student.rosterMatched && student.rosterName) {
    student.displayName = student.rosterName;
  } else if (!student.displayName) {
    student.displayName = student.googleName;
  }
  student.updatedAt = now;
  if (!student.graph) student.graph = emptyGraph();
  if (!student.outlook) student.outlook = emptyOutlook();
  if (!student.teams) student.teams = emptyTeams();
  return saveStudent(student);
}

export async function updateStudentProfile(student, patch) {
  const s = hydrate(student);
  const src = patch && typeof patch === "object" ? patch : {};
  if (src.school !== undefined) s.school = normalizeSchool(src.school);
  if (src.studentId !== undefined) s.studentId = normalizeStudentId(src.studentId);
  if (src.canvasHost !== undefined) {
    const host = String(src.canvasHost).trim();
    s.canvasHost = host || defaultCanvasHost(s.door);
  }
  if (src.canvasToken !== undefined) s.canvasToken = String(src.canvasToken);
  if (src.canvasRefreshToken !== undefined) s.canvasRefreshToken = String(src.canvasRefreshToken || "");
  if (src.canvasTokenExp !== undefined) s.canvasTokenExp = Number(src.canvasTokenExp) || 0;
  if (src.canvasAuthMode !== undefined) s.canvasAuthMode = src.canvasAuthMode === "oauth" ? "oauth" : "";
  if (src.modelKeys !== undefined) {
    s.modelKeys = normalizeModelKeys(src.modelKeys, "");
    s.modelKey = s.modelKeys[0] || "";
  } else if (src.modelKey !== undefined) {
    const next = studentModelKeys(s);
    const pasted = normalizeModelKey(src.modelKey);
    if (pasted && !next.includes(pasted)) {
      if (next.length >= MODEL_KEY_LIMIT) {
        throw new Error("That's 8 keys. Remove one first.");
      }
      next.push(pasted);
    }
    s.modelKeys = next;
    s.modelKey = next[0] || "";
  }
  if (src.modelProvider !== undefined) s.modelProvider = normalizeModelProvider(src.modelProvider);
  if (src.displayName !== undefined) {
    const name = String(src.displayName).trim();
    if (name) s.displayName = name;
  }
  if (src.rosterName !== undefined) s.rosterName = String(src.rosterName).trim();
  if (src.rosterMatched !== undefined) s.rosterMatched = Boolean(src.rosterMatched);
  if (s.rosterMatched && s.rosterName) s.displayName = s.rosterName;
  else if (!s.displayName) s.displayName = s.googleName;
  s.updatedAt = new Date().toISOString();
  return saveStudent(s);
}

/* ---------------- sessions ---------------- */

function isSessionId(sid) {
  return SESSION_ID_RE.test(sid) && sid !== LEGACY_SESSIONS_DOC;
}

function sessionRecord(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.studentId !== "string") return null;
  try {
    assertFileId(raw.studentId);
  } catch {
    return null;
  }
  return {
    studentId: raw.studentId,
    createdAt: String(raw.createdAt || ""),
    lastSeenAt: String(raw.lastSeenAt || raw.createdAt || ""),
  };
}

/**
 * One-time move from the single sessions/all doc (files: data/sessions.json) to one
 * doc per session. Existing per-session docs win; the legacy doc is deleted afterwards.
 * In files mode listIds("sessions") never reports "all" because the alias file sits
 * beside the sessions/ directory, not inside it. Firestore would list it, so every
 * session listing filters through isSessionId().
 */
async function migrateLegacySessions() {
  let raw;
  try {
    raw = await getDoc(SESSIONS, LEGACY_SESSIONS_DOC);
  } catch {
    return;
  }
  if (!raw || typeof raw !== "object") return;
  let moved = 0;
  try {
    for (const [sid, entry] of Object.entries(raw)) {
      if (!isSessionId(sid)) continue;
      const rec = sessionRecord(entry);
      if (!rec) continue;
      if (await getDoc(SESSIONS, sid)) continue;
      await putDoc(SESSIONS, sid, rec);
      moved += 1;
    }
    await deleteDoc(SESSIONS, LEGACY_SESSIONS_DOC);
    console.log(`sessions: migrated ${moved} legacy session(s) to per-session docs`);
  } catch (err) {
    console.error("sessions: legacy migration failed:", err?.message || err);
  }
}

/** Serialise doc writes so create/destroy from sync callers land in order. */
function queueWrite(fn) {
  const p = writeChain.then(fn).catch((err) => {
    console.error("sessions: write failed:", err?.message || err);
  });
  writeChain = p;
  return p;
}

/** Sync for index.js (`const sid = createSession(...)`); the doc write is queued. */
export function createSession(studentIdKey) {
  const studentId = assertFileId(studentIdKey);
  const sid = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  const rec = { studentId, createdAt: now, lastSeenAt: now };
  sessions.set(sid, rec);
  queueWrite(() => putDoc(SESSIONS, sid, rec));
  return sid;
}

/** Sync for index.js. Returns the queued delete so callers that await it can. */
export function destroySession(sid) {
  const key = String(sid || "").trim();
  if (!key || !isSessionId(key)) return Promise.resolve();
  sessions.delete(key);
  return queueWrite(() => deleteDoc(SESSIONS, key));
}

/** Sign out everywhere / account deletion. Returns how many sessions were removed. */
export async function destroySessionsForStudent(fileId) {
  const id = assertFileId(fileId);
  await writeChain;
  for (const [sid, rec] of sessions) {
    if (rec.studentId === id) sessions.delete(sid);
  }
  let docs;
  try {
    docs = await listDocs(SESSIONS);
  } catch {
    docs = [];
  }
  let removed = 0;
  for (const { id: sid, data } of docs) {
    if (!isSessionId(sid) || data?.studentId !== id) continue;
    if (await deleteDoc(SESSIONS, sid)) removed += 1;
  }
  return removed;
}

/** Test hook: drop the in-memory cache so the next lookup hits the doc store. */
export async function _resetSessionCache() {
  await writeChain;
  sessions.clear();
}

async function resolveSession(sid) {
  const cached = sessions.get(sid);
  if (cached) return cached;
  await writeChain;
  const again = sessions.get(sid);
  if (again) return again;
  let raw;
  try {
    raw = await getDoc(SESSIONS, sid);
  } catch {
    return null;
  }
  const rec = sessionRecord(raw);
  if (!rec) return null;
  sessions.set(sid, rec);
  return rec;
}

function touchSession(sid, rec) {
  const last = Date.parse(rec.lastSeenAt || "") || 0;
  const now = Date.now();
  if (now - last < LAST_SEEN_WRITE_MS) return;
  rec.lastSeenAt = new Date(now).toISOString();
  const snapshot = { ...rec };
  queueWrite(async () => {
    if (!sessions.has(sid)) return;
    await putDoc(SESSIONS, sid, snapshot);
  });
}

function cookieMap(req) {
  const header = req?.headers?.cookie;
  if (!header) return new Map();
  const map = new Map();
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      map.set(name, decodeURIComponent(value));
    } catch {
      map.set(name, value);
    }
  }
  return map;
}

export function sessionIdFromRequest(req) {
  const fromCookie = cookieMap(req).get(COOKIE);
  if (fromCookie) return String(fromCookie).trim();
  const fromHeader =
    (typeof req?.get === "function" && req.get(HEADER)) ||
    req?.headers?.[HEADER] ||
    "";
  return String(fromHeader).trim();
}

export async function studentFromRequest(req) {
  await sessionsReady;
  const sid = sessionIdFromRequest(req);
  if (!sid || !isSessionId(sid)) return null;
  const rec = await resolveSession(sid);
  if (!rec?.studentId) return null;
  const student = await loadStudentByFileId(rec.studentId);
  if (!student) return null;
  touchSession(sid, rec);
  return student;
}

/**
 * Remove the student doc and every session that points at it. Notes, chats, workspace,
 * vault, schedules, and research belong to their own modules; index.js deletes those first.
 */
export async function deleteStudentAccount(fileId) {
  const id = assertFileId(fileId);
  const count = await destroySessionsForStudent(id);
  await deleteDoc(STUDENTS, id);
  return { ok: true, sessions: count };
}

function isHttps(req) {
  const proto = String(req?.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return Boolean(req?.secure) || proto === "https";
}

function cookieHeader(req, sid, clear) {
  const https = isHttps(req);
  const parts = [
    `${COOKIE}=${clear ? "" : encodeURIComponent(sid)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${https ? "None" : "Lax"}`,
    `Max-Age=${clear ? 0 : SESSION_MAX_AGE}`,
  ];
  if (https) parts.push("Secure");
  return parts.join("; ");
}

function appendSetCookie(res, value) {
  if (typeof res.append === "function") {
    res.append("Set-Cookie", value);
    return;
  }
  const prev = res.getHeader?.("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", value);
    return;
  }
  res.setHeader("Set-Cookie", Array.isArray(prev) ? prev.concat(value) : [prev, value]);
}

export function setSessionCookie(req, res, sid) {
  const value = String(sid || "").trim();
  if (!value) throw new Error("Session id is required.");
  appendSetCookie(res, cookieHeader(req, value, false));
}

export function clearSessionCookie(req, res) {
  appendSetCookie(res, cookieHeader(req, "", true));
}

function mergeTokenBag(bag, patch, extraKeys = []) {
  const src = patch && typeof patch === "object" ? patch : {};
  if (src.accessToken !== undefined) bag.accessToken = String(src.accessToken);
  if (src.refreshToken !== undefined) bag.refreshToken = String(src.refreshToken);
  if (src.exp !== undefined) bag.exp = Number(src.exp) || 0;
  if (src.email !== undefined) bag.email = String(src.email);
  if (src.pending !== undefined) bag.pending = src.pending;
  if (src.denied !== undefined) bag.denied = Boolean(src.denied);
  for (const key of extraKeys) {
    if (src[key] !== undefined) bag[key] = String(src[key] || "");
  }
  return bag;
}

export function mergeGraph(student, patch) {
  if (!student.graph || typeof student.graph !== "object") {
    student.graph = emptyGraph();
  }
  mergeTokenBag(student.graph, patch, ["clientId", "scope"]);
  return student;
}

/** Per-service probe result. Pass null to reset. Keys not in patch keep their value. */
export function mergeMsServices(student, patch) {
  if (patch === null) {
    student.msServices = emptyMsServices();
    return student;
  }
  const cur = hydrateMsServices(student.msServices);
  const src = patch && typeof patch === "object" ? patch : {};
  for (const key of ["files", "notes", "mail", "chats"]) {
    if (src[key] !== undefined) cur[key] = triState(src[key]);
  }
  if (src.email !== undefined) cur.email = String(src.email || "");
  if (src.needsAdminApproval !== undefined) cur.needsAdminApproval = Boolean(src.needsAdminApproval);
  if (src.checkedAt !== undefined) cur.checkedAt = String(src.checkedAt || "");
  if (src.errors !== undefined) {
    const next = {};
    const errs = src.errors && typeof src.errors === "object" ? src.errors : {};
    for (const key of ["files", "notes", "mail", "chats"]) {
      if (errs[key]) next[key] = String(errs[key]).slice(0, 200);
    }
    cur.errors = next;
  }
  student.msServices = cur;
  return student;
}

/** In-flight authorization-code sign-in. Pass null to clear. Never in publicProfile. */
export function mergeMsAuth(student, patch) {
  student.msAuth = patch ? hydrateMsAuth({ ...(student.msAuth || {}), ...patch }) : null;
  return student;
}

/** Fallback when the in-memory state map lost the entry (server restart). */
export async function findStudentByMsAuthState(state) {
  const needle = String(state || "").trim();
  if (!needle) return null;
  const ids = await listStudentFileIds();
  if (!ids) return null;
  for (const fileId of ids) {
    const student = await loadStudentByFileId(fileId).catch(() => null);
    if (student?.msAuth?.state === needle) return student;
  }
  return null;
}

/** Case-insensitive lookup by Google email. Returns { student, fileId } or null. */
export async function findStudentByEmail(email) {
  const needle = String(email || "").trim().toLowerCase();
  if (!needle) return null;
  const ids = await listStudentFileIds();
  if (!ids) return null;
  for (const fileId of ids) {
    const student = await loadStudentByFileId(fileId).catch(() => null);
    if (student && String(student.email || "").toLowerCase() === needle) {
      return { student, fileId };
    }
  }
  return null;
}

/**
 * Move a student to a door and pause or resume them. Only the set-door tool and
 * the future EPS sign-in call this; there is no student-facing route for it.
 */
export async function setStudentDoor(student, { door, paused } = {}) {
  const s = hydrate(student);
  if (door !== undefined) s.door = normalizeDoor(door);
  if (paused !== undefined) s.paused = Boolean(paused);
  s.updatedAt = new Date().toISOString();
  return saveStudent(s);
}

/**
 * Visit every student file. fn(student, fileId) returns true when it changed the
 * student; the file is then written back in place. Used for one-off cleanups at boot.
 */
export async function forEachStudentFile(fn) {
  const ids = await listStudentFileIds();
  if (!ids) return 0;
  let changed = 0;
  for (const fileId of ids) {
    const student = await loadStudentByFileId(fileId).catch(() => null);
    if (!student) continue;
    if (await fn(student, fileId)) {
      await writeStudent(fileId, student);
      changed += 1;
    }
  }
  return changed;
}

export function mergeOutlook(student, patch) {
  if (!student.outlook || typeof student.outlook !== "object") {
    student.outlook = emptyOutlook();
  }
  mergeTokenBag(student.outlook, patch, ["clientId", "scope"]);
  return student;
}

export function mergeTeams(student, patch) {
  if (!student.teams || typeof student.teams !== "object") {
    student.teams = emptyTeams();
  }
  mergeTokenBag(student.teams, patch, ["clientId", "scope"]);
  return student;
}
