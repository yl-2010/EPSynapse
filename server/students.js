/**
 * Google-account student profiles and session cookies.
 * File id is google__{sub}. School + student ID are optional settings.
 * Tokens and the model key stay on disk, never the raw secret in publicProfile().
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { usesCursorAgent } from "./cursor-demo.js";
import { dataRoot, getDoc, listIds, putDoc } from "./store.js";

const STUDENTS = "students";
const SESSIONS = "sessions";
const SESSIONS_DOC = "all";

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

const DEFAULT_CANVAS_HOST = "https://eastsideprep.instructure.com";
const MAX_LEN = 80;
const SESSION_MAX_AGE = 2592000;
const SKEW_SEC = 90;
const ID_CHARS = /^[A-Za-z0-9._@+\- ]+$/;
const PROVIDER_IDS = new Set(["groq", "gemini", "openrouter"]);
const MODEL_KEY_MAX = 256;
const MODEL_KEY_LIMIT = 8;

const sessions = new Map();
const sessionsReady = loadSessions();
let persistChain = sessionsReady;

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
    codeVerifier: String(raw.codeVerifier || ""),
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

function hydrate(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const graph = src.graph && typeof src.graph === "object" ? src.graph : {};
  const outlook = src.outlook && typeof src.outlook === "object" ? src.outlook : {};
  const teams = src.teams && typeof src.teams === "object" ? src.teams : {};
  const modelKeys = normalizeModelKeys(src.modelKeys, src.modelKey);
  return {
    googleSub: String(src.googleSub || ""),
    email: String(src.email || ""),
    googleName: String(src.googleName || ""),
    picture: String(src.picture || ""),
    rosterName: String(src.rosterName || ""),
    rosterMatched: Boolean(src.rosterMatched),
    door: normalizeDoor(src.door),
    paused: Boolean(src.paused),
    school: String(src.school || ""),
    studentId: String(src.studentId || ""),
    canvasHost: String(src.canvasHost || DEFAULT_CANVAS_HOST),
    canvasToken: String(src.canvasToken || ""),
    // Canvas OAuth (EPS door, canvas-oauth.js). Empty for a pasted manual token.
    canvasRefreshToken: String(src.canvasRefreshToken || ""),
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
    graph: {
      accessToken: String(graph.accessToken || ""),
      refreshToken: String(graph.refreshToken || ""),
      exp: Number(graph.exp) || 0,
      email: String(graph.email || ""),
      pending: graph.pending ?? null,
      clientId: String(graph.clientId || ""),
      scope: String(graph.scope || ""),
      denied: Boolean(graph.denied),
    },
    outlook: {
      accessToken: String(outlook.accessToken || ""),
      refreshToken: String(outlook.refreshToken || ""),
      exp: Number(outlook.exp) || 0,
      email: String(outlook.email || ""),
      pending: outlook.pending ?? null,
      clientId: String(outlook.clientId || ""),
      scope: String(outlook.scope || ""),
      denied: Boolean(outlook.denied),
    },
    teams: {
      accessToken: String(teams.accessToken || ""),
      refreshToken: String(teams.refreshToken || ""),
      exp: Number(teams.exp) || 0,
      email: String(teams.email || ""),
      pending: teams.pending ?? null,
      clientId: String(teams.clientId || ""),
      scope: String(teams.scope || ""),
      denied: Boolean(teams.denied),
    },
    msServices: hydrateMsServices(src.msServices),
    msAuth: hydrateMsAuth(src.msAuth),
    msConsentRequestedAt: String(src.msConsentRequestedAt || ""),
    createdAt: String(src.createdAt || ""),
    updatedAt: String(src.updatedAt || ""),
  };
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
  const cursor = usesCursorAgent(s);
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
    cursorAgent: cursor,
    modelKeySet: cursor || s.modelKeys.length > 0,
    modelProvider: cursor ? "cursor" : s.modelProvider || "groq",
    modelKeyHint: cursor ? "cursor" : modelKeyHint(s.modelKeys[0] || s.modelKey),
    modelKeyHints: cursor ? ["cursor"] : s.modelKeys.map(modelKeyHint),
    modelKeyCount: cursor ? Math.max(1, s.modelKeys.length) : s.modelKeys.length,
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

async function writeStudent(fileId, data) {
  await putDoc(STUDENTS, assertFileId(fileId), data);
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
  } catch {
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
    canvasHost: DEFAULT_CANVAS_HOST,
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
    s.canvasHost = host || DEFAULT_CANVAS_HOST;
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

async function loadSessions() {
  const raw = await getDoc(SESSIONS, SESSIONS_DOC);
  if (!raw || typeof raw !== "object") return;
  for (const [sid, rec] of Object.entries(raw)) {
    if (!sid || !rec || typeof rec.studentId !== "string") continue;
    sessions.set(sid, {
      studentId: rec.studentId,
      createdAt: rec.createdAt || "",
    });
  }
}

async function persistSessions() {
  const obj = {};
  for (const [sid, rec] of sessions) obj[sid] = rec;
  await putDoc(SESSIONS, SESSIONS_DOC, obj);
}

function schedulePersist() {
  persistChain = persistChain.then(() => persistSessions()).catch(() => {});
}

export function createSession(studentIdKey) {
  const studentId = assertFileId(studentIdKey);
  const sid = randomBytes(32).toString("hex");
  sessions.set(sid, { studentId, createdAt: new Date().toISOString() });
  schedulePersist();
  return sid;
}

export function destroySession(sid) {
  const key = String(sid || "").trim();
  if (!key) return;
  sessions.delete(key);
  schedulePersist();
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
  if (!sid) return null;
  const rec = sessions.get(sid);
  if (!rec?.studentId) return null;
  return loadStudentByFileId(rec.studentId);
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
