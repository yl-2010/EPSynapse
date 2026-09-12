/**
 * Google-account student profiles and session cookies.
 * File id is google__{sub}. School + student ID are optional settings.
 * Tokens and the model key stay on disk, never the raw secret in publicProfile().
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const COOKIE = "epsynapse_sid";
export const HEADER = "x-epsynapse-session";

const DEFAULT_CANVAS_HOST = "https://eastsideprep.instructure.com";
const MAX_LEN = 80;
const SESSION_MAX_AGE = 2592000;
const SKEW_SEC = 90;
const ID_CHARS = /^[A-Za-z0-9._@+\- ]+$/;
const PROVIDER_IDS = new Set(["groq", "gemini", "openrouter"]);
const MODEL_KEY_MAX = 256;

const sessions = new Map();
const sessionsReady = loadSessions();
let persistChain = sessionsReady;

export function studentsDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "data", "students");
}

function dataDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "data");
}

function sessionsPath() {
  return join(dataDir(), "sessions.json");
}

function emptyGraph() {
  return {
    accessToken: "",
    refreshToken: "",
    exp: 0,
    email: "",
    pending: null,
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

function studentPath(fileId) {
  const id = assertFileId(fileId);
  const dir = resolve(studentsDir());
  const full = resolve(dir, `${id}.json`);
  if (full !== join(dir, `${id}.json`) && !full.startsWith(dir + sep)) {
    throw new Error("Invalid student file id.");
  }
  return full;
}

function hydrate(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const graph = src.graph && typeof src.graph === "object" ? src.graph : {};
  const outlook = src.outlook && typeof src.outlook === "object" ? src.outlook : {};
  return {
    googleSub: String(src.googleSub || ""),
    email: String(src.email || ""),
    googleName: String(src.googleName || ""),
    picture: String(src.picture || ""),
    rosterName: String(src.rosterName || ""),
    rosterMatched: Boolean(src.rosterMatched),
    school: String(src.school || ""),
    studentId: String(src.studentId || ""),
    canvasHost: String(src.canvasHost || DEFAULT_CANVAS_HOST),
    canvasToken: String(src.canvasToken || ""),
    modelKey: String(src.modelKey || ""),
    modelProvider: normalizeModelProvider(src.modelProvider),
    displayName: String(src.displayName || ""),
    graph: {
      accessToken: String(graph.accessToken || ""),
      refreshToken: String(graph.refreshToken || ""),
      exp: Number(graph.exp) || 0,
      email: String(graph.email || ""),
      pending: graph.pending ?? null,
    },
    outlook: {
      accessToken: String(outlook.accessToken || ""),
      refreshToken: String(outlook.refreshToken || ""),
      exp: Number(outlook.exp) || 0,
      email: String(outlook.email || ""),
      pending: outlook.pending ?? null,
      clientId: String(outlook.clientId || ""),
      scope: String(outlook.scope || ""),
    },
    createdAt: String(src.createdAt || ""),
    updatedAt: String(src.updatedAt || ""),
  };
}

function graphConnected(graph) {
  if (!graph?.accessToken) return false;
  const exp = Number(graph.exp) || 0;
  return exp > Math.floor(Date.now() / 1000) - SKEW_SEC;
}

function publicPending(pending) {
  if (!pending || typeof pending !== "object") return null;
  const user_code = String(pending.user_code || "");
  const verification_uri = String(pending.verification_uri || "");
  const message = String(pending.message || "");
  if (!user_code && !verification_uri && !message) return null;
  return { user_code, verification_uri, message };
}

export function publicProfile(student) {
  const s = hydrate(student);
  return {
    email: s.email,
    googleName: s.googleName,
    picture: s.picture,
    school: s.school,
    studentId: s.studentId,
    rosterName: s.rosterName,
    rosterMatched: s.rosterMatched,
    canvasHost: s.canvasHost,
    displayName: s.displayName,
    canvasConnected: Boolean(s.canvasToken),
    modelKeySet: Boolean(s.modelKey),
    modelProvider: s.modelProvider || "groq",
    modelKeyHint: modelKeyHint(s.modelKey),
    onedriveConnected: graphConnected(s.graph),
    onedriveEmail: s.graph.email || "",
    onedrivePending: publicPending(s.graph.pending),
    outlookConnected: graphConnected(s.outlook),
    outlookEmail: s.outlook.email || "",
    outlookPending: publicPending(s.outlook.pending),
  };
}

async function writeJsonAtomic(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function loadStudentByFileId(fileId) {
  let path;
  try {
    path = studentPath(fileId);
  } catch {
    return null;
  }
  try {
    return hydrate(JSON.parse(await readFile(path, "utf8")));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
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
  await writeJsonAtomic(studentPath(googleFileId(s.googleSub)), s);
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
    school: "",
    studentId: "",
    canvasHost: DEFAULT_CANVAS_HOST,
    canvasToken: "",
    modelKey: "",
    modelProvider: "groq",
    displayName: "",
    graph: emptyGraph(),
    outlook: emptyOutlook(),
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
  if (src.modelKey !== undefined) s.modelKey = normalizeModelKey(src.modelKey);
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
  try {
    const raw = JSON.parse(await readFile(sessionsPath(), "utf8"));
    if (!raw || typeof raw !== "object") return;
    for (const [sid, rec] of Object.entries(raw)) {
      if (!sid || !rec || typeof rec.studentId !== "string") continue;
      sessions.set(sid, {
        studentId: rec.studentId,
        createdAt: rec.createdAt || "",
      });
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function persistSessions() {
  const obj = {};
  for (const [sid, rec] of sessions) obj[sid] = rec;
  await writeJsonAtomic(sessionsPath(), obj);
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
  for (const key of extraKeys) {
    if (src[key] !== undefined) bag[key] = String(src[key] || "");
  }
  return bag;
}

export function mergeGraph(student, patch) {
  if (!student.graph || typeof student.graph !== "object") {
    student.graph = emptyGraph();
  }
  mergeTokenBag(student.graph, patch);
  return student;
}

export function mergeOutlook(student, patch) {
  if (!student.outlook || typeof student.outlook !== "object") {
    student.outlook = emptyOutlook();
  }
  mergeTokenBag(student.outlook, patch, ["clientId", "scope"]);
  return student;
}
