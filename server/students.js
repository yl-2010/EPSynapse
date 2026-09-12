/**
 * Honor-system student profiles and session cookies.
 * School + student ID. Tokens stay on disk, never in publicProfile().
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

function normalizeSchool(raw) {
  const school = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!school) throw new Error("School is required.");
  if (school.length > MAX_LEN) throw new Error("School is too long.");
  if (/[/\\\0]/.test(school)) throw new Error("Invalid school.");
  return school;
}

export function normalizeStudentId(raw) {
  const id = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!id) throw new Error("Student id is required.");
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
    school: String(src.school || ""),
    studentId: String(src.studentId || ""),
    canvasHost: String(src.canvasHost || DEFAULT_CANVAS_HOST),
    canvasToken: String(src.canvasToken || ""),
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
    school: s.school,
    studentId: s.studentId,
    canvasHost: s.canvasHost,
    displayName: s.displayName,
    canvasConnected: Boolean(s.canvasToken),
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
  s.school = normalizeSchool(s.school);
  s.studentId = normalizeStudentId(s.studentId);
  if (!s.createdAt) s.createdAt = new Date().toISOString();
  if (!s.updatedAt) s.updatedAt = s.createdAt;
  await writeJsonAtomic(studentPath(safeFileId(s.school, s.studentId)), s);
  return s;
}

export async function upsertStudent({
  school,
  studentId,
  canvasHost,
  canvasToken,
  displayName,
}) {
  const sch = normalizeSchool(school);
  const sid = normalizeStudentId(studentId);
  const now = new Date().toISOString();
  const existing = await loadStudent(sch, sid);
  const student = existing ?? {
    school: sch,
    studentId: sid,
    canvasHost: DEFAULT_CANVAS_HOST,
    canvasToken: "",
    displayName: "",
    graph: emptyGraph(),
    outlook: emptyOutlook(),
    createdAt: now,
    updatedAt: now,
  };
  student.school = sch;
  student.studentId = sid;
  if (canvasHost !== undefined) {
    const host = String(canvasHost).trim();
    student.canvasHost = host || DEFAULT_CANVAS_HOST;
  }
  if (canvasToken !== undefined) student.canvasToken = String(canvasToken);
  if (displayName !== undefined) student.displayName = String(displayName).trim();
  student.updatedAt = now;
  if (!student.graph) student.graph = emptyGraph();
  if (!student.outlook) student.outlook = emptyOutlook();
  return saveStudent(student);
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

function sessionIdFromRequest(req) {
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
