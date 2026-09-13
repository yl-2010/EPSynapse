/**
 * JYPE / EPSynapse Mac Express API.
 * Cloudflare Tunnel to this process. Port 3006. Leave 3000 / 3002 / 3004 alone.
 *
 * Port 3006 — public hostname api.epsynapse.com (own tunnel).
 */

// Must stay the first import: it awaits Secret Manager (App Engine) before any other
// module reads process.env. See boot-secrets.js and docs/GCP.md.
import "./boot-secrets.js";
import express from "express";
import cors from "cors";
import {
  PROVIDERS,
  consumeSse,
  explainUpstreamError,
  extractChatDelta,
  upstreamErrorCode,
  extractToolCalls,
  finishedToolCalls,
  formatUiContextBlock,
  mergeToolCallDeltas,
  normalizeUiContext,
  publicAgentConfig,
  MISSING_KEY_ERROR,
  fetchWithKeyCycle,
  resolveApiKeys,
  sanitizeMessages,
  upstreamBody,
  upstreamHeaders,
} from "./agent.js";
import { AGENT_TOOLS, executeAgentTool, navigateHref, normalizeNavigate } from "./agent-tools.js";
import { runCursorAgentChat } from "./cursor-agent.js";
import { usesCursorAgent } from "./cursor-demo.js";
import {
  applyScheduleToGrades,
  dashboardPayload,
  isNonGradeCourse,
  listAssignments,
  listCourses,
  listGrades,
  normalizeHost,
  validateToken,
} from "./canvas.js";
import {
  adminConsentUrl,
  bagMatchesClient,
  buildAuthorizeUrl,
  downloadFile,
  ensureFreshToken,
  exchangeAuthCode,
  hasLiveToken,
  isConnected,
  listDashboardFiles,
  MS_OFF_MESSAGE,
  msClientMode,
  msConfigured,
  msScopes,
  needsAdminApprovalText,
  newOauthState,
  newPkcePair,
  probeDenied,
  probeGraph,
  probeReauth,
  searchFiles,
  tokenHasNotesRead,
  uploadFile,
  userDeclinedText,
  WRITE_FOLDER,
} from "./onedrive.js";
import {
  createPage as createOnenotePage,
  getPage as getOnenotePage,
  listNotebooks,
  listPages as listOnenotePages,
  listSections as listOnenoteSections,
  onenoteError,
  snapshotNotebooks,
} from "./onenote.js";
import { publicGoogleConfig, verifyIdToken } from "./google.js";
import {
  ensureFreshToken as ensureOutlookToken,
  isConnected as outlookConnected,
  listEvents,
  listMessages,
  readMessage,
  sendMessage,
} from "./outlook.js";
import {
  ensureFreshToken as ensureTeamsToken,
  isConnected as teamsGraphConnected,
  listChats as listTeamsChats,
  listChatMessages as listTeamsMessages,
  sendChatMessage as sendTeamsGraph,
} from "./teams.js";
import {
  isStudioDemoStudent,
  listStudioChatMessages,
  listStudioChats,
  listStudioFiles,
  readStudioFile,
  sendStudioChat,
  studioFlags,
  studioOnenoteToken,
  studioOutlookToken,
  writeStudioFile,
} from "./studio-ms.js";
import { listVault, readVault, saveVault } from "./vault.js";
import { getSchool, listSchools, publicSchool, setRoster } from "./schools.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  findStudentByMsAuthState,
  forEachStudentFile,
  googleFileId,
  isPaused,
  loadStudentByFileId,
  mergeGraph,
  mergeMsAuth,
  mergeMsServices,
  mergeOutlook,
  mergeTeams,
  publicProfile,
  saveStudent,
  PAUSED_MESSAGE,
  sessionIdFromRequest,
  setSessionCookie,
  studentFromRequest,
  studentModelKeys,
  updateStudentProfile,
  upsertGoogleStudent,
} from "./students.js";
import {
  chatHistoryIsUnread,
  listChats,
  loadChat,
  markChatRead,
  ownerIdForStudent,
  persistChat,
} from "./chat-history.js";
import multer from "multer";
import { bertEnabled, probeBertService } from "./bert.js";
import { canvasOAuthPublic, ensureFreshCanvasToken, mountCanvasOAuth } from "./canvas-oauth.js";
import { four11Configured, mountFour11 } from "./four11.js";
import { listNotes, mountNotes } from "./notes.js";
import { mountResearch } from "./research-metrics.js";
import { loadSchedule, mountSchedule } from "./schedule.js";
import {
  applyClassAliases,
  hideCanvasTodo,
  isLocalTodoId,
  listAllClassFiles,
  listAllTodoFiles,
  listClassFiles,
  listTodoFiles,
  listTodos,
  loadWorkspaceMeta,
  mergeAssignments,
  parseClassFileId,
  parseTodoFileId,
  patchTodo,
  setCanvasTodoDone,
  readClassFile,
  readTodoFile,
  renameClass,
  writeClassFile,
  writeTodoFile,
  deleteClassFile,
  deleteTodoFile,
  createTodo,
  deleteTodo,
  workspaceSnapshotBits,
} from "./workspace.js";

const PORT = Number(process.env.PORT || 3006);
const HOST = process.env.HOST || "0.0.0.0";
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (!allowed.length || allowed.includes("*") || allowed.includes(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "8mb" }));

/**
 * Paused accounts (EPS students waiting for the school sign-in) can still load
 * /v1/me, which reports paused: true, and log out. Every other student route,
 * and the agent answer 423 so no tool or sync runs for them.
 */
const PAUSE_OPEN_PATHS = new Set(["/v1/me", "/v1/me/logout"]);
const PAUSE_GATED_PREFIXES = ["/v1/me/", "/v1/agent/"];

function pauseGated(path) {
  if (PAUSE_OPEN_PATHS.has(path)) return false;
  return PAUSE_GATED_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p));
}

app.use(async (req, res, next) => {
  if (!pauseGated(req.path)) return next();
  try {
    let student = await studentFromRequest(req);
    if (!student) {
      const raw = String(req.get("authorization") || "").trim();
      const m = /^Bearer\s+(.+)$/i.exec(raw);
      if (m) student = await studentFromRequest({ headers: { "x-epsynapse-session": m[1].trim() } });
    }
    if (student && isPaused(student)) {
      return res.status(423).json({ error: PAUSED_MESSAGE, paused: true, door: student.door });
    }
  } catch {
    /* fall through; the route does its own auth */
  }
  return next();
});

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const name = String(file?.originalname || "").toLowerCase();
    const type = String(file?.mimetype || "");
    if (type === "application/pdf" || name.endsWith(".pdf")) {
      cb(null, true);
      return;
    }
    cb(new Error("Upload a PDF."));
  },
});

function fail(res, err, fallback = 500) {
  const status = Number(err?.status) || fallback;
  const safe = status >= 400 && status < 600 ? status : fallback;
  return res.status(safe).json({
    error: String(err?.message || "Request failed."),
  });
}

async function requireStudent(req, res) {
  const student = await studentFromRequest(req);
  if (!student) {
    res.status(401).json({
      error: "Sign in with Google first.",
    });
    return null;
  }
  // No-op unless the student connected Canvas through OAuth and the hour is nearly up.
  return ensureFreshCanvasToken(student);
}

const MS_REDIRECT_URI =
  String(process.env.MICROSOFT_REDIRECT_URI || "").trim() ||
  "https://api.epsynapse.com/v1/ms/callback";
const MS_DEFAULT_RETURN = "https://epsynapse.com";
const MS_AUTH_TTL_MS = 15 * 60 * 1000;
const MS_REPROBE_MS = 30 * 60 * 1000;
const MS_SERVICES = ["onedrive", "onenote", "outlook", "teams"];
const MS_SERVICE_KEY = { onedrive: "files", onenote: "notes", outlook: "mail", teams: "chats" };
const MS_SERVICE_LABEL = { onedrive: "OneDrive", onenote: "OneNote", outlook: "Outlook", teams: "Teams" };
const MS_ACCESS_LABEL = { files: "Files", notes: "OneNote", mail: "Mail", chats: "Teams chat" };

/** state -> { fileId, createdAt }. Callback has no cookie, so this finds the student. */
const msAuthStates = new Map();

function msServiceName(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return MS_SERVICES.includes(s) ? s : "";
}

function msServicesOf(student) {
  const src = student?.msServices && typeof student.msServices === "object" ? student.msServices : {};
  return {
    email: String(src.email || ""),
    files: src.files === true ? true : src.files === false ? false : null,
    notes: src.notes === true ? true : src.notes === false ? false : null,
    mail: src.mail === true ? true : src.mail === false ? false : null,
    chats: src.chats === true ? true : src.chats === false ? false : null,
    errors: src.errors && typeof src.errors === "object" ? src.errors : {},
    needsAdminApproval: Boolean(src.needsAdminApproval),
    checkedAt: String(src.checkedAt || ""),
  };
}

/** Plain sentence for one denied service, or "" when it works or was never checked. */
function msDeniedReason(ms, key, token) {
  if (ms[key] !== false) return "";
  const err = String(ms.errors?.[key] || "");
  const label = MS_ACCESS_LABEL[key] || key;
  if (key === "notes" && /no Notes\.Read scope/i.test(err)) {
    return "This Microsoft sign-in has no OneNote read access. School IT has to approve EPSynapse.";
  }
  if (probeReauth(err)) {
    return `Microsoft wants a fresh sign-in before ${label} works again. Connect again.`;
  }
  if (probeDenied(err)) {
    return `Microsoft denied ${label} access. School IT has to approve EPSynapse.`;
  }
  if (/unavailable|5\d\d/.test(err)) {
    return `Microsoft did not answer for ${label} (${err.split(" ")[0] || "server error"}). Try again later.`;
  }
  if (!token) return `${label} is not connected.`;
  return `Microsoft refused ${label} access (${err || "unknown error"}).`;
}

function msNeedsAdminApproval(ms) {
  if (ms.needsAdminApproval) return true;
  for (const key of ["files", "notes", "mail", "chats"]) {
    if (ms[key] === false && probeDenied(ms.errors?.[key])) return true;
    if (key === "notes" && ms.notes === false && /no Notes\.Read/i.test(ms.errors?.notes || "")) return true;
  }
  return false;
}

function msSignedInEmail(student) {
  const ms = msServicesOf(student);
  return (
    ms.email ||
    student?.graph?.email ||
    student?.outlook?.email ||
    student?.teams?.email ||
    ""
  );
}

function onenoteGraphConnected(student, ms) {
  return hasLiveToken(student?.graph) && ms.notes === true;
}

function outlookReallyConnected(student, ms) {
  return outlookConnected(student?.outlook) && ms.mail !== false;
}

function teamsReallyConnected(student, ms) {
  return teamsGraphConnected(student?.teams) && ms.chats !== false;
}

function onedriveReallyConnected(student, ms) {
  return isConnected(student?.graph) && ms.files !== false;
}

function publicMe(student) {
  const flags = studioFlags(student);
  const base = publicProfile(student);
  const ms = msServicesOf(student);
  const graphTok = hasLiveToken(student?.graph);
  const denied = {
    onedrive: flags.onedrive ? "" : msDeniedReason(ms, "files", graphTok),
    onenote: flags.onenote ? "" : msDeniedReason(ms, "notes", graphTok),
    outlook: flags.outlook ? "" : msDeniedReason(ms, "mail", hasLiveToken(student?.outlook)),
    teams: flags.teams ? "" : msDeniedReason(ms, "chats", hasLiveToken(student?.teams)),
  };
  const needsApproval = msNeedsAdminApproval(ms);
  return {
    ...base,
    onedriveConnected: Boolean(onedriveReallyConnected(student, ms) || flags.onedrive),
    onenoteConnected: Boolean(onenoteGraphConnected(student, ms) || flags.onenote),
    onenoteEmail: base.onedriveEmail || "",
    outlookConnected: Boolean(outlookReallyConnected(student, ms) || flags.outlook),
    teamsConnected: Boolean(teamsReallyConnected(student, ms) || flags.teams),
    studioOnedrive: flags.onedrive,
    studioOnenote: flags.onenote,
    studioOutlook: flags.outlook,
    studioTeams: flags.teams,
    msClientMode: msClientMode(),
    msConfigured: msConfigured(),
    msSignedInEmail: msSignedInEmail(student),
    msDenied: denied,
    msNeedsAdminApproval: needsApproval,
    msCheckedAt: ms.checkedAt,
    adminConsentUrl: adminConsentUrl(),
    consentRequest: consentRequestFor(student, "onenote"),
    canvasOAuth: canvasOAuthPublic(student),
    four11Configured: four11Configured(),
  };
}

function safeReturnTo(raw) {
  const s = String(raw || "").trim();
  if (!s) return MS_DEFAULT_RETURN;
  if (/^epsynapse:\/\//i.test(s)) return "epsynapse://";
  let url;
  try {
    url = new URL(s);
  } catch {
    return MS_DEFAULT_RETURN;
  }
  const origin = url.origin;
  const allowedOrigins = new Set([
    "https://epsynapse.com",
    "https://www.epsynapse.com",
    "https://jype-six.vercel.app",
  ]);
  if (allowedOrigins.has(origin)) return origin;
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return origin;
  }
  return MS_DEFAULT_RETURN;
}

function liveMsAuth(student) {
  const auth = student?.msAuth;
  if (!auth?.state || !auth.codeVerifier) return null;
  const created = Date.parse(auth.createdAt || "") || 0;
  if (!created || Date.now() - created > MS_AUTH_TTL_MS) return null;
  return auth;
}

function studentSchoolEmail(student) {
  const ms = msSignedInEmail(student);
  if (ms) return ms;
  const email = String(student?.email || "");
  return /@eastsideprep\.org$/i.test(email) ? email : "";
}

/** Email the student can send to school IT. Never depends on the demo path. */
function consentRequestFor(student, service) {
  const to = String(process.env.SCHOOL_IT_EMAIL || "").trim();
  const svc = msServiceName(service) || "onenote";
  const label = MS_SERVICE_LABEL[svc];
  const name = String(student?.displayName || student?.googleName || "A student").trim();
  const schoolEmail = studentSchoolEmail(student);
  const who = schoolEmail ? `${name} (${schoolEmail})` : name;
  const consent = adminConsentUrl();
  const subject = "Please approve EPSynapse for Microsoft 365 (OneNote, OneDrive, Outlook, Teams)";
  const body = [
    "Hi,",
    "",
    `${who} is asking for EPSynapse to be approved on the Eastside Prep Microsoft 365 tenant. ${label} is what I need right now.`,
    "",
    "EPSynapse is a student home for EPS. It puts Canvas, OneNote, OneDrive, Outlook, and Teams on one page so a student can see their own work in one place.",
    "",
    "It asks for these delegated Microsoft Graph permissions (signed-in user only):",
    `  ${msScopes()}`,
    "",
    "Admin consent link (opens the Microsoft approval page for this app):",
    consent,
    "",
    "Each student signs in with their own school account and EPSynapse can only read that student's own data. Nothing is shared across students.",
    "",
    "Thank you,",
    name,
  ].join("\n");
  const q = new URLSearchParams({ subject, body });
  const mailto = `mailto:${encodeURIComponent(to)}?${q.toString().replace(/\+/g, "%20")}`;
  return { to, subject, body, mailto, adminConsentUrl: consent };
}

function sessionJson(req, res, student, sid) {
  if (sid) setSessionCookie(req, res, sid);
  return res.json({
    ...publicMe(student),
    sessionId: sid || "",
  });
}

const studentLocks = new Map();

function withStudentLock(fileId, fn) {
  const key = String(fileId || "");
  const prev = studentLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  studentLocks.set(
    key,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
}

function shortMsError(err) {
  return String(err?.message || "Graph failed")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function mergeListedFiles(...lists) {
  const byId = new Set();
  const byName = new Set();
  const out = [];
  for (const list of lists) {
    for (const row of list || []) {
      const id = String(row?.id || "").trim();
      const name = String(row?.name || "").trim();
      if (id && byId.has(id)) continue;
      if (name && byName.has(name)) continue;
      if (id) byId.add(id);
      if (name) byName.add(name);
      out.push(row);
    }
  }
  return out;
}

async function safeProbe(accessToken) {
  const empty = {
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
  try {
    return await probeGraph(accessToken);
  } catch (err) {
    const text = shortMsError(err);
    return {
      ...empty,
      error: text,
      errors: { files: text, notes: text, mail: text, chats: text },
    };
  }
}

function logProbe(email, probe) {
  console.log(
    `[ms-oauth] probe email=${email || ""} files=${probe.files} notes=${probe.notes} mail=${probe.mail} chats=${probe.chats} calendar=${probe.calendar}` +
      (Object.keys(probe.errors || {}).length ? ` errors=${JSON.stringify(probe.errors)}` : "")
  );
}

/**
 * Store a fresh Microsoft token only where Graph proved it works.
 * graph gets it when Files or OneNote answered (OneNote rides on the graph bag).
 * outlook gets it when the Inbox answered. teams gets it when /me/chats answered.
 * If nothing answered, graph keeps it with denied=true so we can refresh and re-probe.
 */
async function applyMicrosoftToken(current, poll, pending, extra = {}) {
  const bag = {
    accessToken: poll.accessToken,
    refreshToken: poll.refreshToken,
    exp: poll.exp,
    email: poll.email,
    clientId: poll.clientId || pending?.clientId || "",
    scope: poll.scope || pending?.scope || "",
    pending: null,
    denied: false,
  };
  const probe = await safeProbe(poll.accessToken);
  if (probe.email) bag.email = probe.email;
  const { files, notes, mail, chats } = probe;
  const prev = msServicesOf(current);
  const patch = {
    email: bag.email || "",
    errors: { ...prev.errors },
    needsAdminApproval: Boolean(extra.needsAdminApproval),
    checkedAt: new Date().toISOString(),
  };
  // A bag that already holds a different working token keeps its flag. This new token
  // may carry narrower scopes and say nothing about that service.
  const keepOther = (bagName) => hasLiveToken(current[bagName]) && !current[bagName].denied;
  const record = (key, ok) => {
    patch[key] = ok;
    if (ok) delete patch.errors[key];
    else patch.errors[key] = probe.errors?.[key] || probe.error || "no answer";
  };

  if (files || notes) {
    mergeGraph(current, { ...bag, denied: !files });
    record("files", files);
    record("notes", notes);
  } else if (!mail && !chats) {
    mergeGraph(current, { ...bag, denied: true });
    record("files", false);
    record("notes", false);
  } else {
    mergeGraph(current, { pending: null });
    if (!keepOther("graph")) {
      record("files", false);
      record("notes", false);
    }
  }
  if (mail) {
    mergeOutlook(current, bag);
    record("mail", true);
  } else {
    mergeOutlook(current, { pending: null });
    if (!keepOther("outlook")) {
      if (hasLiveToken(current.outlook)) mergeOutlook(current, { denied: true });
      record("mail", false);
    }
  }
  if (chats) {
    mergeTeams(current, bag);
    record("chats", true);
  } else {
    mergeTeams(current, { pending: null });
    if (!keepOther("teams")) {
      if (hasLiveToken(current.teams)) mergeTeams(current, { denied: true });
      record("chats", false);
    }
  }

  mergeMsServices(current, patch);
  await saveStudent(current);
  logProbe(bag.email, probe);
  return probe;
}

/**
 * Re-run the honest probe on tokens we already hold. Used when a status call finds
 * a token that was stored before per-service checks existed, or a stale check.
 */
async function reprobeMicrosoft(student) {
  const jobs = [];
  const seen = new Map();
  for (const key of ["graph", "outlook", "teams"]) {
    const bag = student[key];
    if (!hasLiveToken(bag)) continue;
    const token = String(bag.accessToken);
    if (!seen.has(token)) {
      seen.set(token, safeProbe(token));
    }
    jobs.push([key, token]);
  }
  if (!jobs.length) return null;
  const results = new Map();
  for (const [token, p] of seen) results.set(token, await p);
  const patch = { errors: {}, checkedAt: new Date().toISOString() };
  let email = "";
  for (const [key, token] of jobs) {
    const probe = results.get(token);
    if (!probe) continue;
    if (probe.email) email = probe.email;
    if (key === "graph") {
      patch.files = probe.files;
      patch.notes = probe.notes;
      if (probe.errors.files) patch.errors.files = probe.errors.files;
      if (probe.errors.notes) patch.errors.notes = probe.errors.notes;
      mergeGraph(student, { denied: !probe.files });
    } else if (key === "outlook") {
      patch.mail = probe.mail;
      if (probe.errors.mail) patch.errors.mail = probe.errors.mail;
      mergeOutlook(student, { denied: !probe.mail });
    } else if (key === "teams") {
      patch.chats = probe.chats;
      if (probe.errors.chats) patch.errors.chats = probe.errors.chats;
      mergeTeams(student, { denied: !probe.chats });
    }
  }
  if (email) patch.email = email;
  mergeMsServices(student, patch);
  await saveStudent(student);
  const ms = msServicesOf(student);
  console.log(
    `[ms-oauth] reprobe email=${ms.email} files=${ms.files} notes=${ms.notes} mail=${ms.mail} chats=${ms.chats}` +
      (Object.keys(ms.errors).length ? ` errors=${JSON.stringify(ms.errors)}` : "")
  );
  return ms;
}

function probeIsStale(student) {
  const ms = msServicesOf(student);
  const at = Date.parse(ms.checkedAt || "") || 0;
  return !at || Date.now() - at > MS_REPROBE_MS;
}

async function reprobeIfStale(student) {
  if (!probeIsStale(student)) return student;
  const hasAny = hasLiveToken(student.graph) || hasLiveToken(student.outlook) || hasLiveToken(student.teams);
  if (!hasAny) return student;
  try {
    await reprobeMicrosoft(student);
  } catch (err) {
    console.warn("[ms-oauth] reprobe failed", shortMsError(err));
  }
  return student;
}

function deniedError(student, key, label) {
  const ms = msServicesOf(student);
  const reason = msDeniedReason(ms, key, true) || `Microsoft denied ${label} access.`;
  const err = new Error(reason);
  err.status = 403;
  err.denied = true;
  return err;
}

async function graphToken(student) {
  if (student.graph?.denied) throw deniedError(student, "files", "Files");
  const fresh = await ensureFreshToken(student.graph);
  if (fresh !== student.graph) {
    mergeGraph(student, fresh);
    await saveStudent(student);
  }
  return fresh.accessToken;
}

async function outlookToken(student) {
  if (student.outlook?.denied) throw deniedError(student, "mail", "Mail");
  const fresh = await ensureOutlookToken(student.outlook);
  if (fresh !== student.outlook) {
    mergeOutlook(student, fresh);
    await saveStudent(student);
  }
  return fresh.accessToken;
}

async function teamsToken(student) {
  if (student.teams?.denied) throw deniedError(student, "chats", "Teams chat");
  const fresh = await ensureTeamsToken(student.teams);
  if (fresh !== student.teams) {
    mergeTeams(student, fresh);
    await saveStudent(student);
  }
  return fresh.accessToken;
}

async function outlookAccessToken(student) {
  if (student.outlook?.accessToken) return outlookToken(student);
  if (isStudioDemoStudent(student)) return studioOutlookToken();
  return "";
}

async function liveSnapshot(student) {
  const bits = [];
  if (student.displayName) bits.push(`Student: ${student.displayName}`);
  if (student.school) bits.push(`School: ${student.school}`);

  if (student.canvasToken) {
    try {
      const dash = await dashboardPayload(student.canvasHost, student.canvasToken);
      const ownerId = ownerIdForStudent(student);
      const meta = ownerId
        ? await loadWorkspaceMeta(ownerId).catch(() => ({ hiddenTodoIds: [], canvasTodoDone: {} }))
        : { hiddenTodoIds: [], canvasTodoDone: {} };
      const assignments = mergeAssignments(dash.assignments, [], meta.hiddenTodoIds, meta.canvasTodoDone);
      const courses = (dash.courses || []).map((c) => c.name).filter(Boolean).slice(0, 12);
      const open = (assignments || [])
        .filter((a) => !a.done)
        .slice(0, 8)
        .map((a) => {
          const due = a.due ? a.due.slice(0, 10) : "no due";
          return `${a.tag} ${a.title} (${a.courseName || "class"}) ${due}`;
        });
      const grades = (dash.courses || [])
        .filter((c) => !isNonGradeCourse(c) && (c.currentGrade || c.currentScore != null))
        .slice(0, 12)
        .map((c) => {
          const pct = c.currentScore != null ? `${c.currentScore}%` : "";
          return [c.name, c.currentGrade, pct].filter(Boolean).join(" ");
        });
      bits.push(`Courses: ${courses.join("; ") || "none listed"}`);
      bits.push(`Open work: ${open.join("; ") || "none"}`);
      if (grades.length) bits.push(`Grades: ${grades.join("; ")}`);
    } catch {
      bits.push("Canvas: could not load this turn.");
    }
  } else {
    bits.push("Canvas: not connected.");
  }

  const fileId = student.googleSub ? googleFileId(student.googleSub) : "";
  let vaultNames = [];
  if (fileId) {
    try {
      vaultNames = (await listVault(fileId)).map((f) => f.name).filter(Boolean);
    } catch {
      vaultNames = [];
    }
  }

  const flags = studioFlags(student);
  if (student.graph?.accessToken) {
    try {
      const token = await graphToken(student);
      const files = await listDashboardFiles(token, { folder: WRITE_FOLDER });
      const names = (files || []).map((f) => f.name).filter(Boolean).slice(0, 12);
      bits.push(`OneDrive recent: ${names.join("; ") || "empty"}`);
    } catch (err) {
      bits.push(`OneDrive: ${shortMsError(err) || "could not list files this turn."}`);
    }
  } else if (flags.onedrive) {
    try {
      const files = await listStudioFiles({ limit: 12 });
      const names = (files || []).map((f) => f.name).filter(Boolean);
      bits.push(`OneDrive on this Mac: ${names.join("; ") || "empty"}`);
    } catch (err) {
      bits.push(`OneDrive: ${shortMsError(err) || "could not list Finder files this turn."}`);
    }
  } else {
    bits.push("OneDrive: not connected.");
  }
  if (student.graph?.accessToken) {
    try {
      const token = await graphToken(student);
      const notebooks = await listNotebooks(token);
      bits.push(`OneNote notebooks: ${snapshotNotebooks(notebooks) || "empty"}`);
    } catch (err) {
      bits.push(`OneNote: ${onenoteError(err)}`);
    }
  } else {
    bits.push("OneNote: not connected. Uses the OneDrive Microsoft sign-in.");
  }
  if (vaultNames.length) {
    bits.push(`Uploaded files: ${vaultNames.slice(0, 8).join("; ")}`);
  }

  const outlookTok = await outlookAccessToken(student).catch(() => "");
  if (outlookTok) {
    try {
      const inbox = await listMessages(outlookTok, { limit: 8 });
      const lines = (inbox || []).map((m) => {
        const when = String(m.received || "").slice(0, 16);
        const flag = m.unread ? "unread" : "read";
        return `${when} ${flag} ${m.fromAddress || m.from}: ${m.subject}`;
      });
      bits.push(`Outlook inbox: ${lines.join(" | ") || "empty"}`);
    } catch (err) {
      bits.push(`Outlook: ${shortMsError(err) || "could not read inbox this turn."}`);
    }
    try {
      const events = await listEvents(outlookTok, { days: 7 });
      const ev = (events || []).slice(0, 5).map((e) => {
        const when = String(e.start || "").slice(0, 16);
        return `${when} ${e.subject || "event"}`;
      });
      if (ev.length) bits.push(`Outlook this week: ${ev.join(" | ")}`);
    } catch {
      /* calendar is optional */
    }
  } else {
    bits.push("Outlook: not connected.");
  }

  if (student.teams?.accessToken) {
    try {
      const token = await teamsToken(student);
      const chats = await listTeamsChats(token, { limit: 8 });
      bits.push(
        `Teams chats: ${(chats || []).map((c) => c.name).filter(Boolean).join("; ") || "empty"}`
      );
    } catch (err) {
      bits.push(`Teams: ${shortMsError(err) || "could not list chats this turn."}`);
    }
  } else if (flags.teams) {
    try {
      const chats = await listStudioChats({ limit: 8 });
      bits.push(
        `Teams chats: ${(chats || []).map((c) => c.name).filter(Boolean).join("; ") || "empty"}`
      );
    } catch (err) {
      bits.push(`Teams: ${shortMsError(err) || "could not list chats this turn."}`);
    }
  } else {
    bits.push("Teams: not connected.");
  }

  const ownerId = ownerIdForStudent(student);
  if (ownerId) {
    try {
      const notes = await listNotes(ownerId);
      if (notes.length) {
        bits.push(
          `Notes: ${notes
            .slice(0, 8)
            .map((n) => `${n.title || "Note"} [${n.subject || "unclassified"}] ${n.id}`)
            .join("; ")}`
        );
      }
    } catch {
      /* notes are optional */
    }
    try {
      bits.push(...(await workspaceSnapshotBits(ownerId)));
    } catch {
      /* workspace is optional */
    }
  }

  bits.push(
    "You can add, edit, check off, and delete notes and todos, add HTML or other files to a class or a todo page, and rename classes. You can also list and write OneDrive files, read and create OneNote pages, read and send Outlook, and read and send Teams when those are connected. Use the tools."
  );

  return bits.join("\n").slice(0, 7000);
}

app.get("/health", async (_req, res) => {
  const bert = await probeBertService();
  res.json({
    ok: true,
    service: "jype-server",
    time: new Date().toISOString(),
    bert: {
      enabled: bertEnabled(),
      ok: Boolean(bert.ok),
      url: "http://127.0.0.1:3007",
      zeroShotLoaded: Boolean(bert.zeroShotLoaded),
      fineTunedLoaded: Boolean(bert.fineTunedLoaded),
    },
  });
});

app.get("/v1/auth/google/config", (_req, res) => {
  res.json(publicGoogleConfig());
});

app.post("/v1/auth/google", async (req, res) => {
  try {
    const claims = await verifyIdToken(req.body?.idToken);
    const student = await upsertGoogleStudent({
      googleSub: claims.sub,
      email: claims.email,
      googleName: claims.name,
      picture: claims.picture,
    });
    const sid = createSession(googleFileId(student.googleSub));
    return sessionJson(req, res, student, sid);
  } catch (err) {
    return fail(res, err, err.status || 401);
  }
});

app.get("/v1/schools", async (req, res) => {
  try {
    const schools = await listSchools(req.query.q);
    return res.json({ schools });
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/schools/:slug", async (req, res) => {
  try {
    const school = await getSchool(req.params.slug);
    if (!school) return res.status(404).json({ error: "School not found." });
    return res.json(publicSchool(school));
  } catch (err) {
    return fail(res, err, 404);
  }
});

app.post("/v1/admin/schools/:slug/roster", async (req, res) => {
  const key = String(process.env.ADMIN_KEY || "").trim();
  if (!key) {
    return res.status(503).json({ error: "Admin key is not configured." });
  }
  const header = String(req.get("authorization") || "");
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (!token || token !== key) {
    return res.status(401).json({ error: "Bad admin key." });
  }
  try {
    const school = await setRoster(req.params.slug, req.body?.students);
    return res.json(publicSchool(school));
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.get("/v1/me", async (req, res) => {
  try {
    const student = await studentFromRequest(req);
    if (!student) {
      return res.status(401).json({ error: "No student session." });
    }
    return res.json(publicMe(student));
  } catch (err) {
    return fail(res, err);
  }
});

app.post("/v1/me", async (req, res) => {
  try {
    const student = await studentFromRequest(req);
    if (!student) {
      return res.status(401).json({ error: "Sign in with Google first." });
    }

    // School and student id are no longer settings. The EPS door identifies the
    // student from the school Microsoft sign-in; the other door has neither.
    const patch = {};
    if (req.body?.canvasHost) patch.canvasHost = normalizeHost(req.body.canvasHost);

    const pasted = String(req.body?.canvasToken || "").trim();
    if (pasted) {
      const self = await validateToken(patch.canvasHost || student.canvasHost, pasted);
      patch.canvasToken = pasted;
      patch.canvasRefreshToken = "";
      patch.canvasTokenExp = 0;
      patch.canvasAuthMode = "";
      if (self.displayName) patch.displayName = self.displayName;
    }

    const updated = await updateStudentProfile(student, patch);
    return sessionJson(req, res, updated, sessionIdFromRequest(req));
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.post("/v1/me/agent", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;

    const patch = {};
    if (req.body?.provider !== undefined) {
      const providerId = String(req.body.provider || "").trim().toLowerCase();
      if (providerId && !PROVIDERS[providerId]) {
        return res.status(400).json({ error: "Unknown provider." });
      }
      if (providerId) patch.modelProvider = providerId;
    }

    if (req.body?.clear) {
      patch.modelKeys = [];
    } else if (req.body?.removeIndex !== undefined) {
      const next = studentModelKeys(student);
      const index = Number(req.body.removeIndex);
      if (!Number.isInteger(index) || index < 0 || index >= next.length) {
        return res.status(400).json({ error: "No key at that index." });
      }
      next.splice(index, 1);
      patch.modelKeys = next;
    } else if (req.body?.modelKey !== undefined) {
      const pasted = String(req.body.modelKey || "").trim();
      if (!pasted) {
        return res.status(400).json({ error: "Paste a key first." });
      }
      patch.modelKey = pasted;
    }

    if (!Object.keys(patch).length) {
      return sessionJson(req, res, student, sessionIdFromRequest(req));
    }

    const updated = await updateStudentProfile(student, patch);
    return sessionJson(req, res, updated, sessionIdFromRequest(req));
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.post("/v1/me/logout", async (req, res) => {
  const headerSid = String(req.get("x-epsynapse-session") || "").trim();
  const cookieHeader = String(req.headers.cookie || "");
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)epsynapse_sid=([^;]+)/);
  const cookieSid = cookieMatch ? decodeURIComponent(cookieMatch[1]) : "";
  if (headerSid) destroySession(headerSid);
  if (cookieSid && cookieSid !== headerSid) destroySession(cookieSid);
  clearSessionCookie(req, res);
  return res.json({ ok: true });
});

app.post("/v1/me/canvas", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const host = normalizeHost(req.body?.canvasHost || student.canvasHost);
    const token = String(req.body?.canvasToken || "").trim();
    if (!token) {
      return res.status(400).json({ error: "Paste a Canvas access token." });
    }
    const self = await validateToken(host, token);
    student.canvasHost = host;
    student.canvasToken = token;
    // A pasted token replaces any OAuth connection; never try to refresh it.
    student.canvasRefreshToken = "";
    student.canvasTokenExp = 0;
    student.canvasAuthMode = "";
    student.displayName = self.displayName || student.displayName;
    await saveStudent(student);
    return res.json(publicMe(student));
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.get("/v1/me/canvas/courses", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    if (!student.canvasToken) {
      return res.status(400).json({ error: "Connect Canvas in settings first." });
    }
    const courses = await listCourses(student.canvasHost, student.canvasToken);
    const ownerId = ownerIdForStudent(student);
    const meta = ownerId ? await loadWorkspaceMeta(ownerId).catch(() => ({ classAliases: {} })) : { classAliases: {} };
    return res.json({ courses: applyClassAliases(courses, meta.classAliases) });
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.get("/v1/me/canvas/assignments", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const ownerId = ownerIdForStudent(student);
    let canvas = [];
    if (student.canvasToken) {
      canvas = await listAssignments(student.canvasHost, student.canvasToken).catch(() => []);
    }
    const local = ownerId ? await listTodos(ownerId).catch(() => []) : [];
    const meta = ownerId
      ? await loadWorkspaceMeta(ownerId).catch(() => ({ hiddenTodoIds: [], canvasTodoDone: {} }))
      : { hiddenTodoIds: [], canvasTodoDone: {} };
    return res.json({ assignments: mergeAssignments(canvas, local, meta.hiddenTodoIds, meta.canvasTodoDone) });
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.post("/v1/me/canvas/assignments/:id/complete", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const ownerId = ownerIdForStudent(student);
    if (ownerId && isLocalTodoId(req.params.id)) {
      return res.json(await patchTodo(ownerId, req.params.id, { done: true }));
    }
    if (!ownerId) {
      return res.status(400).json({ error: "Sign in to check off work." });
    }
    return res.json(await setCanvasTodoDone(ownerId, req.params.id, true, req.body || {}));
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.post("/v1/me/canvas/assignments/:id/incomplete", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const ownerId = ownerIdForStudent(student);
    if (ownerId && isLocalTodoId(req.params.id)) {
      return res.json(await patchTodo(ownerId, req.params.id, { done: false }));
    }
    if (!ownerId) {
      return res.status(400).json({ error: "Sign in to check off work." });
    }
    return res.json(await setCanvasTodoDone(ownerId, req.params.id, false, req.body || {}));
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.get("/v1/me/canvas/grades", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    if (!student.canvasToken) {
      return res.status(400).json({ error: "Connect Canvas in settings first." });
    }
    const work = /^(1|true|yes)$/i.test(String(req.query.work || ""));
    const grades = await listGrades(student.canvasHost, student.canvasToken, { work });
    const ownerId = ownerIdForStudent(student);
    const stored = ownerId ? await loadSchedule(ownerId).catch(() => ({ classes: [] })) : { classes: [] };
    return res.json({ grades: applyScheduleToGrades(grades, stored.classes || []) });
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

/* ---------- Microsoft sign-in: auth code + PKCE only, or off when MICROSOFT_CLIENT_ID is unset ---------- */

async function startAppAuth(student, service, returnTo) {
  const state = newOauthState();
  const { codeVerifier, codeChallenge } = newPkcePair();
  const authorizeUrl = buildAuthorizeUrl({
    state,
    codeChallenge,
    redirectUri: MS_REDIRECT_URI,
    loginHint: studentSchoolEmail(student),
  });
  const fileId = googleFileId(student.googleSub);
  mergeMsAuth(student, {
    state,
    codeVerifier,
    service,
    returnTo: safeReturnTo(returnTo),
    authorizeUrl,
    createdAt: new Date().toISOString(),
  });
  await saveStudent(student);
  msAuthStates.set(state, { fileId, createdAt: Date.now() });
  for (const [k, v] of msAuthStates) {
    if (Date.now() - v.createdAt > MS_AUTH_TTL_MS) msAuthStates.delete(k);
  }
  return {
    mode: "app",
    service,
    authorizeUrl,
    state,
    adminConsentUrl: adminConsentUrl(),
    consentRequest: consentRequestFor(student, service),
    verification_uri: authorizeUrl,
    verification_uri_complete: authorizeUrl,
    message: `Open the link to sign in with your school Microsoft account and allow ${MS_SERVICE_LABEL[service]}.`,
  };
}

/** 503 body when MICROSOFT_CLIENT_ID is unset. The only other path is auth code + PKCE. */
function msOffPayload(service) {
  return { error: MS_OFF_MESSAGE, mode: "off", configured: false, service };
}

/** Start the browser sign-in, or 503 when Microsoft is off. Never a device code. */
async function startMicrosoftRoute(req, res, service) {
  const student = await requireStudent(req, res);
  if (!student) return;
  if (!msConfigured()) return res.status(503).json(msOffPayload(service));
  return res.json(await startAppAuth(student, service, req.body?.returnTo));
}

app.post("/v1/me/ms/start", async (req, res) => {
  try {
    const service = msServiceName(req.body?.service);
    if (!service) {
      return res.status(400).json({ error: "service must be onedrive, onenote, outlook, or teams." });
    }
    return await startMicrosoftRoute(req, res, service);
  } catch (err) {
    return fail(res, err);
  }
});

app.post("/v1/me/onedrive/start", async (req, res) => {
  try {
    return await startMicrosoftRoute(req, res, "onedrive");
  } catch (err) {
    return fail(res, err);
  }
});

function appPendingFor(student) {
  const auth = liveMsAuth(student);
  if (!auth) return null;
  return { authorizeUrl: auth.authorizeUrl, service: auth.service, state: auth.state };
}

function statusExtras(student, service, flags) {
  const ms = msServicesOf(student);
  const key = MS_SERVICE_KEY[service];
  const studio = Boolean(flags[service]);
  const reason = studio ? "" : msDeniedReason(ms, key, true);
  return {
    denied: Boolean(reason),
    deniedReason: reason,
    needsAdminApproval: studio ? false : msNeedsAdminApproval(ms),
    consentRequest: consentRequestFor(student, service),
    mode: msClientMode(),
    configured: msConfigured(),
    msSignedInEmail: msSignedInEmail(student),
    adminConsentUrl: adminConsentUrl(),
  };
}

/**
 * Freshest copy of the student for a status call. Also drops any Microsoft token that
 * did not come from our app registration; there is no flow left that could refresh it.
 */
async function freshStudentForStatus(student) {
  const fileId = googleFileId(student.googleSub);
  return withStudentLock(fileId, async () => {
    const current = (await loadStudentByFileId(fileId)) || student;
    if (dropForeignMicrosoftTokens(current)) await saveStudent(current);
    return current;
  });
}

app.get("/v1/me/onedrive/status", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const current = await freshStudentForStatus(student);
    await reprobeIfStale(current);
    const flags = studioFlags(current);
    const ms = msServicesOf(current);
    return res.json({
      connected: Boolean(onedriveReallyConnected(current, ms) || flags.onedrive),
      pending: appPendingFor(current),
      email: current.graph?.email || "",
      error: "",
      studio: flags.onedrive,
      ...statusExtras(current, "onedrive", flags),
      outlookConnected: Boolean(outlookReallyConnected(current, ms) || flags.outlook),
      outlookEmail: current.outlook?.email || "",
    });
  } catch (err) {
    return fail(res, err);
  }
});

function callbackResult(student, service, exchange) {
  const ms = msServicesOf(student);
  const key = MS_SERVICE_KEY[service] || "files";
  if (exchange && !exchange.ok) {
    if (exchange.declined) {
      return { result: "denied", reason: "You cancelled the Microsoft sign-in.", needsAdminApproval: false };
    }
    if (exchange.needsAdminApproval) {
      return {
        result: "denied",
        reason: "Microsoft needs school IT to approve EPSynapse first.",
        needsAdminApproval: true,
      };
    }
    return {
      result: "error",
      reason: `Microsoft sign-in failed (${exchange.error || "unknown"}).`,
      needsAdminApproval: false,
    };
  }
  if (ms[key] === true) return { result: "connected", reason: "", needsAdminApproval: false };
  const reason = msDeniedReason(ms, key, true) || `Microsoft did not grant ${MS_SERVICE_LABEL[service]} access.`;
  return { result: "denied", reason, needsAdminApproval: msNeedsAdminApproval(ms) };
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function callbackPage({ service, result, reason, email, returnTo }) {
  const label = MS_SERVICE_LABEL[service] || "Microsoft";
  let line;
  if (result === "connected") {
    line = `${label} connected${email ? ` as ${email}` : ""}. You can close this tab.`;
  } else if (result === "denied") {
    line = reason || "Microsoft needs school IT to approve EPSynapse first.";
  } else {
    line = reason || "Microsoft sign-in failed. Close this tab and try again.";
  }
  const jsSafe = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const payload = jsSafe({ type: "epsynapse-ms", service, result, reason, email });
  const fallbackUrl =
    `${returnTo}/?ms=${encodeURIComponent(result)}&service=${encodeURIComponent(service)}` +
    (reason ? `&reason=${encodeURIComponent(reason)}` : "");
  const fallback = jsSafe(fallbackUrl);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>EPSynapse</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1115;color:#f3f4f6}
main{max-width:28rem;padding:2rem;text-align:center}
h1{font-size:1.1rem;font-weight:600;margin:0 0 .5rem}
p{margin:.25rem 0;color:#c9ccd3}
a{color:#8ab4ff}
</style></head>
<body><main>
<h1>EPSynapse</h1>
<p>${escapeHtml(line)}</p>
<p><a id="back" href="${escapeHtml(fallbackUrl)}">Back to EPSynapse</a></p>
</main>
<script>
(function(){
  var msg=${payload};
  try{ if(window.opener && !window.opener.closed){ window.opener.postMessage(msg,"*"); } }catch(e){}
  try{ window.close(); }catch(e){}
  setTimeout(function(){ if(!window.closed){ location.replace(${fallback}); } },400);
})();
</script>
</body></html>`;
}

async function findMsAuthStudent(state) {
  const key = String(state || "").trim();
  if (!key) return null;
  const hit = msAuthStates.get(key);
  if (hit?.fileId) {
    const s = await loadStudentByFileId(hit.fileId).catch(() => null);
    if (s?.msAuth?.state === key) return s;
  }
  return findStudentByMsAuthState(key);
}

app.get("/v1/ms/callback", async (req, res) => {
  const state = String(req.query.state || "").trim();
  const code = String(req.query.code || "").trim();
  const oauthError = String(req.query.error || "").trim();
  const oauthDesc = String(req.query.error_description || "").trim();
  let service = "onedrive";
  let returnTo = MS_DEFAULT_RETURN;
  let email = "";
  let outcome = { result: "error", reason: "", needsAdminApproval: false };
  try {
    const student = await findMsAuthStudent(state);
    if (!student) {
      outcome = { result: "error", reason: "This sign-in link is stale. Start again from EPSynapse.", needsAdminApproval: false };
    } else {
      const auth = student.msAuth || {};
      service = msServiceName(auth.service) || "onedrive";
      returnTo = safeReturnTo(auth.returnTo);
      const fileId = googleFileId(student.googleSub);
      await withStudentLock(fileId, async () => {
        const current = (await loadStudentByFileId(fileId)) || student;
        if (oauthError) {
          const text = `${oauthError} ${oauthDesc}`;
          const exchange = {
            ok: false,
            error: oauthError,
            errorDescription: oauthDesc,
            declined: oauthError === "access_denied" && (userDeclinedText(text) || !needsAdminApprovalText(text)),
            needsAdminApproval: needsAdminApprovalText(text),
          };
          if (exchange.needsAdminApproval) {
            mergeMsServices(current, { needsAdminApproval: true, checkedAt: new Date().toISOString() });
          }
          mergeMsAuth(current, null);
          await saveStudent(current);
          console.warn(`[ms-oauth] callback error service=${service} error=${oauthError} ${oauthDesc.slice(0, 160)}`);
          outcome = callbackResult(current, service, exchange);
          return;
        }
        const exchange = await exchangeAuthCode({
          code,
          codeVerifier: auth.codeVerifier,
          redirectUri: MS_REDIRECT_URI,
        });
        if (!exchange.ok) {
          if (exchange.needsAdminApproval) {
            mergeMsServices(current, { needsAdminApproval: true, checkedAt: new Date().toISOString() });
          }
          mergeMsAuth(current, null);
          await saveStudent(current);
          console.warn(`[ms-oauth] exchange failed service=${service} ${exchange.error} ${exchange.errorDescription || ""}`);
          outcome = callbackResult(current, service, exchange);
          return;
        }
        mergeMsAuth(current, null);
        await applyMicrosoftToken(current, exchange, null);
        email = msSignedInEmail(current);
        outcome = callbackResult(current, service, null);
      });
      msAuthStates.delete(state);
    }
  } catch (err) {
    console.warn("[ms-oauth] callback", shortMsError(err));
    outcome = { result: "error", reason: shortMsError(err), needsAdminApproval: false };
  }
  const { result, reason } = outcome;
  if (returnTo === "epsynapse://") {
    // encodeURIComponent, not URLSearchParams: iOS URLComponents does not turn "+" into a space.
    const parts = [`service=${encodeURIComponent(service)}`, `result=${encodeURIComponent(result)}`];
    if (reason) parts.push(`reason=${encodeURIComponent(reason)}`);
    if (email) parts.push(`email=${encodeURIComponent(email)}`);
    return res.redirect(302, `epsynapse://ms?${parts.join("&")}`);
  }
  res.setHeader("Cache-Control", "no-store");
  res.type("html");
  return res.send(callbackPage({ service, result, reason, email, returnTo }));
});

function clearBag(student, key) {
  const patch = { accessToken: "", refreshToken: "", exp: 0, email: "", pending: null, denied: false, clientId: "", scope: "" };
  if (key === "graph") mergeGraph(student, patch);
  if (key === "outlook") mergeOutlook(student, patch);
  if (key === "teams") mergeTeams(student, patch);
}

/**
 * Drop any Microsoft token or pending sign-in that did not come from our own app
 * registration. Tokens from the removed device-code flow have another clientId (or
 * none) and nothing can refresh them any more. Returns true when something changed.
 */
function dropForeignMicrosoftTokens(student) {
  let changed = false;
  for (const key of ["graph", "outlook", "teams"]) {
    const bag = student?.[key];
    if (!bag || typeof bag !== "object") continue;
    const hasToken = Boolean(String(bag.accessToken || "").trim() || String(bag.refreshToken || "").trim());
    const stalePending = bag.pending && typeof bag.pending === "object";
    if ((hasToken && !bagMatchesClient(bag)) || stalePending) {
      clearBag(student, key);
      changed = true;
    }
  }
  if (changed) mergeMsServices(student, null);
  return changed;
}

async function purgeForeignMicrosoftTokensAtBoot() {
  try {
    const n = await forEachStudentFile((student) => dropForeignMicrosoftTokens(student));
    if (n) console.log(`[ms-oauth] dropped Microsoft tokens from ${n} student file(s) that did not come from MICROSOFT_CLIENT_ID`);
  } catch (err) {
    console.warn("[ms-oauth] token purge failed", shortMsError(err));
  }
}

app.post("/v1/me/ms/disconnect", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const raw = String(req.body?.service || "").trim().toLowerCase();
    const service = raw === "all" ? "all" : msServiceName(raw);
    if (!service) {
      return res.status(400).json({ error: "service must be onedrive, onenote, outlook, teams, or all." });
    }
    if (service === "all") {
      clearBag(student, "graph");
      clearBag(student, "outlook");
      clearBag(student, "teams");
      mergeMsServices(student, null);
    } else if (service === "onedrive" || service === "onenote") {
      clearBag(student, "graph");
      mergeMsServices(student, { files: null, notes: null });
    } else if (service === "outlook") {
      clearBag(student, "outlook");
      mergeMsServices(student, { mail: null });
    } else if (service === "teams") {
      clearBag(student, "teams");
      mergeMsServices(student, { chats: null });
    }
    mergeMsAuth(student, null);
    await saveStudent(student);
    return res.json(publicMe(student));
  } catch (err) {
    return fail(res, err);
  }
});

app.post("/v1/me/ms/consent-request", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const service = msServiceName(req.body?.service) || "onenote";
    const note = String(req.body?.note || "").trim().slice(0, 500);
    const request = consentRequestFor(student, service);
    if (note) {
      request.body = `${request.body}\n\nNote from the student:\n${note}`;
      const q = new URLSearchParams({ subject: request.subject, body: request.body });
      request.mailto = `mailto:${encodeURIComponent(request.to)}?${q.toString().replace(/\+/g, "%20")}`;
    }
    student.msConsentRequestedAt = new Date().toISOString();
    await saveStudent(student);
    console.log(
      `[ms-consent] requested service=${service} student=${student.email || student.googleSub} to=${request.to || "(no SCHOOL_IT_EMAIL)"}`
    );
    let sent = false;
    let sendError = "";
    const ms = msServicesOf(student);
    const canMail = ms.mail === true || studioFlags(student).outlook;
    if (request.to && canMail) {
      try {
        const token = await outlookAccessToken(student);
        if (token) {
          await sendMessage(token, { to: request.to, subject: request.subject, body: request.body });
          sent = true;
        }
      } catch (err) {
        sendError = shortMsError(err);
        console.warn("[ms-consent] send failed", sendError);
      }
    }
    return res.json({ ok: true, sent, sendError, ...request });
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/me/onedrive/files", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const fileId = googleFileId(student.googleSub);
    const folder = String(req.query.folder || WRITE_FOLDER);
    const q = String(req.query.q || "").trim();
    let vaultFiles = await listVault(fileId);
    if (q) {
      const needle = q.toLowerCase();
      vaultFiles = vaultFiles.filter((f) => String(f.name || "").toLowerCase().includes(needle));
    }
    let graphFiles = [];
    let studioFiles = [];
    let error = "";
    if (student.graph?.accessToken) {
      try {
        const token = await graphToken(student);
        graphFiles = q
          ? await searchFiles(token, q)
          : await listDashboardFiles(token, { folder });
      } catch (err) {
        error = shortMsError(err);
      }
    }
    if (studioFlags(student).onedrive) {
      try {
        studioFiles = await listStudioFiles({ q, limit: 40 });
      } catch (err) {
        if (!error) error = shortMsError(err);
      }
    }
    return res.json({
      files: mergeListedFiles(vaultFiles, graphFiles, studioFiles),
      folder,
      error,
    });
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.get("/v1/me/onedrive/file", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const id = String(req.query.id || "").trim();
    let file;
    if (id.startsWith("vault:")) {
      file = await readVault(googleFileId(student.googleSub), id.slice("vault:".length));
    } else if (id.startsWith("studio:")) {
      file = await readStudioFile(id);
    } else if (!student.graph?.accessToken && studioFlags(student).onedrive) {
      file = await readStudioFile(id);
    } else {
      if (!student.graph?.accessToken) {
        return res.status(400).json({ error: "Open that file in OneDrive." });
      }
      const token = await graphToken(student);
      file = await downloadFile(token, id);
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${String(file.name || "file").replace(/"/g, "")}"`
    );
    return res.send(file.buffer);
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

/** OneNote rides on the graph bag. Uses the token even when Files was denied. */
async function onenoteGraphToken(student) {
  const fresh = await ensureFreshToken(student.graph);
  if (fresh !== student.graph) {
    mergeGraph(student, fresh);
    await saveStudent(student);
  }
  return fresh.accessToken;
}

async function onenoteAccess(student) {
  if (studioFlags(student).onenote) {
    const tok = await studioOnenoteToken();
    if (tok) return tok;
  }
  const ms = msServicesOf(student);
  if (hasLiveToken(student?.graph) && ms.notes === false) {
    throw deniedError(student, "notes", "OneNote");
  }
  if (!student?.graph?.accessToken) {
    const err = new Error("Connect OneNote in settings first.");
    err.status = 400;
    throw err;
  }
  return onenoteGraphToken(student);
}

app.get("/v1/me/onenote/status", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const flags = studioFlags(student);
    let notebooks = [];
    let error = "";
    let listed = false;
    if (flags.onenote) {
      try {
        const token = await studioOnenoteToken();
        if (token) {
          notebooks = await listNotebooks(token);
          listed = true;
        }
      } catch (err) {
        error = onenoteError(err);
      }
    }
    if (!listed && hasLiveToken(student.graph)) {
      try {
        const token = await onenoteGraphToken(student);
        notebooks = await listNotebooks(token);
        listed = true;
        if (msServicesOf(student).notes !== true) {
          mergeMsServices(student, { notes: true, errors: { ...msServicesOf(student).errors, notes: "" } });
          await saveStudent(student);
        }
      } catch (err) {
        const status = Number(err?.status) || 0;
        const ms = msServicesOf(student);
        if (status === 401 || status === 403) {
          const text = tokenHasNotesRead(student.graph?.accessToken)
            ? `${status} denied`
            : `${status} denied (token has no Notes.Read scope)`;
          const errors = { ...ms.errors, notes: ms.errors.notes || text };
          mergeMsServices(student, { notes: false, errors, checkedAt: ms.checkedAt || new Date().toISOString() });
          await saveStudent(student);
        }
        error = msDeniedReason(msServicesOf(student), "notes", true) || onenoteError(err);
      }
    }
    const ms = msServicesOf(student);
    const connected = Boolean(listed || flags.onenote);
    const reason = flags.onenote ? "" : msDeniedReason(ms, "notes", hasLiveToken(student.graph));
    if (!connected && !error) {
      error = reason || (hasLiveToken(student.graph) ? "OneNote did not answer." : "");
    }
    return res.json({
      connected,
      email: student.graph?.email || "",
      notebooks,
      error,
      denied: Boolean(reason),
      deniedReason: reason,
      needsAdminApproval: flags.onenote ? false : msNeedsAdminApproval(ms),
      studio: flags.onenote,
      pending: connected ? null : appPendingFor(student),
      adminConsentUrl: adminConsentUrl(),
      consentRequest: consentRequestFor(student, "onenote"),
      mode: msClientMode(),
      msSignedInEmail: msSignedInEmail(student),
    });
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/me/onenote/notebooks", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const token = await onenoteAccess(student);
    return res.json({ notebooks: await listNotebooks(token), error: "" });
  } catch (err) {
    return res.status(err.status || 502).json({ notebooks: [], error: onenoteError(err) });
  }
});

app.get("/v1/me/onenote/sections", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const token = await onenoteAccess(student);
    return res.json({
      sections: await listOnenoteSections(token, req.query.notebook || req.query.notebookId),
      error: "",
    });
  } catch (err) {
    return res.status(err.status || 502).json({ sections: [], error: onenoteError(err) });
  }
});

app.get("/v1/me/onenote/pages", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const token = await onenoteAccess(student);
    return res.json({
      pages: await listOnenotePages(token, {
        sectionId: req.query.section || req.query.sectionId,
        q: req.query.q,
        limit: Number(req.query.limit) || 20,
      }),
      error: "",
    });
  } catch (err) {
    return res.status(err.status || 502).json({ pages: [], error: onenoteError(err) });
  }
});

app.get("/v1/me/onenote/page", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const id = String(req.query.id || "").trim();
    if (!id) return res.status(400).json({ error: "id is required." });
    const token = await onenoteAccess(student);
    return res.json({ page: await getOnenotePage(token, id), error: "" });
  } catch (err) {
    return fail(res, Object.assign(err, { message: onenoteError(err) }), err.status || 502);
  }
});

app.post("/v1/me/onenote/pages", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const token = await onenoteAccess(student);
    return res.json(
      await createOnenotePage(token, {
        sectionId: req.body?.sectionId || req.body?.section,
        title: req.body?.title,
        text: req.body?.text,
        html: req.body?.html,
      })
    );
  } catch (err) {
    return fail(res, Object.assign(err, { message: onenoteError(err) }), err.status || 400);
  }
});

app.post("/v1/me/outlook/start", async (req, res) => {
  try {
    return await startMicrosoftRoute(req, res, "outlook");
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/me/outlook/status", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const current = await freshStudentForStatus(student);
    await reprobeIfStale(current);
    const flags = studioFlags(current);
    const ms = msServicesOf(current);
    return res.json({
      connected: Boolean(outlookReallyConnected(current, ms) || flags.outlook),
      pending: appPendingFor(current),
      email: current.outlook?.email || "",
      error: "",
      studio: flags.outlook,
      ...statusExtras(current, "outlook", flags),
      onedriveConnected: Boolean(onedriveReallyConnected(current, ms) || flags.onedrive),
      onedriveEmail: current.graph?.email || "",
    });
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/me/outlook/messages", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const token = await outlookAccessToken(student);
    if (!token) {
      return res.json({ messages: [], error: "" });
    }
    try {
      const search = String(req.query.q || "").trim();
      const limit = Number(req.query.limit) || 20;
      const messages = await listMessages(token, { search, limit });
      return res.json({ messages, error: "" });
    } catch (err) {
      return res.json({ messages: [], error: shortMsError(err) });
    }
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.get("/v1/me/outlook/events", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const token = await outlookAccessToken(student);
    if (!token) {
      return res.json({ events: [], error: "" });
    }
    try {
      const days = Number(req.query.days) || 7;
      const events = await listEvents(token, { days });
      return res.json({ events, error: "" });
    } catch (err) {
      return res.json({ events: [], error: shortMsError(err) });
    }
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.get("/v1/me/outlook/message", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const token = await outlookAccessToken(student);
    if (!token) {
      return res.status(400).json({ error: "Open that message in Outlook." });
    }
    const message = await readMessage(token, req.query.id);
    return res.json({ message });
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.post("/v1/me/outlook/send", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const token = await outlookAccessToken(student);
    if (!token) {
      return res.status(400).json({ error: "Connect Outlook first." });
    }
    const sent = await sendMessage(token, {
      to: req.body?.to,
      subject: req.body?.subject,
      body: req.body?.body,
    });
    return res.json(sent);
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.post("/v1/me/teams/start", async (req, res) => {
  try {
    return await startMicrosoftRoute(req, res, "teams");
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/me/teams/status", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const current = await freshStudentForStatus(student);
    await reprobeIfStale(current);
    const flags = studioFlags(current);
    const ms = msServicesOf(current);
    return res.json({
      connected: Boolean(teamsReallyConnected(current, ms) || flags.teams),
      pending: appPendingFor(current),
      email: current.teams?.email || "",
      error: "",
      studio: flags.teams,
      ...statusExtras(current, "teams", flags),
    });
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/me/teams/chats", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const limit = Number(req.query.limit) || 20;
    if (student.teams?.accessToken) {
      const token = await teamsToken(student);
      return res.json({ chats: await listTeamsChats(token, { limit }), error: "" });
    }
    if (studioFlags(student).teams) {
      return res.json({ chats: await listStudioChats({ limit }), error: "" });
    }
    return res.json({ chats: [], error: "" });
  } catch (err) {
    return res.json({ chats: [], error: shortMsError(err) });
  }
});

app.get("/v1/me/teams/messages", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const chat = String(req.query.chat || req.query.id || "").trim();
    const limit = Number(req.query.limit) || 20;
    if (!chat) return res.status(400).json({ error: "chat is required." });
    if (student.teams?.accessToken) {
      const token = await teamsToken(student);
      return res.json({ messages: await listTeamsMessages(token, chat, { limit }), error: "" });
    }
    if (studioFlags(student).teams) {
      return res.json({ messages: await listStudioChatMessages(chat, { limit }), error: "" });
    }
    return res.json({ messages: [], error: "Connect Teams first." });
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.post("/v1/me/teams/send", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const chat = String(req.body?.chat || "").trim();
    const text = String(req.body?.text || "").trim();
    if (student.teams?.accessToken) {
      const token = await teamsToken(student);
      return res.json(await sendTeamsGraph(token, { chat, text }));
    }
    if (studioFlags(student).teams) {
      return res.json(await sendStudioChat({ chat, text }));
    }
    return res.status(400).json({ error: "Connect Teams first." });
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.put("/v1/me/onedrive/file", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const name = String(req.body?.name || "").trim();
    let content = req.body?.content;
    if (req.body?.encoding === "base64") {
      content = Buffer.from(String(content || ""), "base64");
    }
    const contentType = String(req.body?.contentType || "text/plain");
    const saved = await saveVault(googleFileId(student.googleSub), {
      name,
      content,
      contentType,
    });
    if (studioFlags(student).onedrive) {
      try {
        const studio = await writeStudioFile({ name, content, contentType });
        if (!student.graph?.accessToken) {
          return res.json({ ...saved, ...studio, error: "" });
        }
      } catch (err) {
        if (!student.graph?.accessToken) {
          return res.json({ ...saved, error: shortMsError(err) });
        }
      }
    }
    if (!student.graph?.accessToken) {
      return res.json({ ...saved, error: "" });
    }
    try {
      const token = await graphToken(student);
      const uploaded = await uploadFile(token, { name, content, contentType });
      return res.json({
        ...saved,
        webUrl: uploaded.webUrl || saved.webUrl,
        size: uploaded.size || saved.size,
        error: "",
      });
    } catch (err) {
      return res.json({ ...saved, error: shortMsError(err) });
    }
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

async function ownerFromStudent(req, res) {
  const student = await requireStudent(req, res);
  if (!student) return null;
  const ownerId = ownerIdForStudent(student);
  if (!ownerId) {
    res.status(401).json({ error: "Sign in with Google first." });
    return null;
  }
  return { student, ownerId };
}

app.get("/v1/me/todos", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    return res.json({ todos: await listTodos(ctx.ownerId) });
  } catch (err) {
    return fail(res, err);
  }
});

app.post("/v1/me/todos", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    return res.json({ todo: await createTodo(ctx.ownerId, req.body || {}) });
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.patch("/v1/me/todos/:id", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    return res.json({ todo: await patchTodo(ctx.ownerId, req.params.id, req.body || {}) });
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.delete("/v1/me/todos/:id", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    if (!isLocalTodoId(req.params.id)) {
      return res.json(await hideCanvasTodo(ctx.ownerId, req.params.id));
    }
    return res.json(await deleteTodo(ctx.ownerId, req.params.id));
  } catch (err) {
    return fail(res, err, err.status || 404);
  }
});

app.patch("/v1/me/classes/:id", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    return res.json(await renameClass(ctx.ownerId, req.params.id, req.body?.name));
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.get("/v1/me/class-files", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    const classId = String(req.query.classId || "").trim();
    const includeText = /^(1|true|yes)$/i.test(String(req.query.text || "1"));
    const files = classId
      ? await listClassFiles(ctx.ownerId, classId, { includeText })
      : await listAllClassFiles(ctx.ownerId, { includeText });
    return res.json({ files, classId });
  } catch (err) {
    return fail(res, err, err.status || 404);
  }
});

app.put("/v1/me/class-files", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    const classId = String(req.body?.classId || req.query.classId || "").trim();
    let content = req.body?.content;
    if (req.body?.encoding === "base64") {
      content = Buffer.from(String(content || ""), "base64");
    }
    const file = await writeClassFile(ctx.ownerId, classId, {
      name: req.body?.name,
      content,
      contentType: req.body?.contentType,
    });
    return res.json({ file });
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.get("/v1/me/class-files/file", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    const parsed = parseClassFileId(req.query.id) || {
      classId: String(req.query.classId || "").trim(),
      name: String(req.query.name || "").trim(),
    };
    const file = await readClassFile(ctx.ownerId, parsed.classId, parsed.name);
    const inline = /html|text|json|javascript|svg/i.test(file.contentType);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="${String(file.name || "file").replace(/"/g, "")}"`
    );
    return res.send(file.buffer);
  } catch (err) {
    return fail(res, err, err.status || 404);
  }
});

app.delete("/v1/me/class-files/file", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    const parsed = parseClassFileId(req.query.id) || {
      classId: String(req.body?.classId || req.query.classId || "").trim(),
      name: String(req.body?.name || req.query.name || "").trim(),
    };
    return res.json(await deleteClassFile(ctx.ownerId, parsed.classId, parsed.name));
  } catch (err) {
    return fail(res, err, err.status || 404);
  }
});

app.get("/v1/me/todo-files", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    const todoId = String(req.query.todoId || "").trim();
    const includeText = /^(1|true|yes)$/i.test(String(req.query.text || "1"));
    const files = todoId
      ? await listTodoFiles(ctx.ownerId, todoId, { includeText })
      : await listAllTodoFiles(ctx.ownerId, { includeText });
    return res.json({ files, todoId });
  } catch (err) {
    return fail(res, err, err.status || 404);
  }
});

app.put("/v1/me/todo-files", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    const todoId = String(req.body?.todoId || req.query.todoId || "").trim();
    let content = req.body?.content;
    if (req.body?.encoding === "base64") {
      content = Buffer.from(String(content || ""), "base64");
    }
    const file = await writeTodoFile(ctx.ownerId, todoId, {
      name: req.body?.name,
      content,
      contentType: req.body?.contentType,
    });
    return res.json({ file });
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.get("/v1/me/todo-files/file", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    const parsed = parseTodoFileId(req.query.id) || {
      todoId: String(req.query.todoId || "").trim(),
      name: String(req.query.name || "").trim(),
    };
    const file = await readTodoFile(ctx.ownerId, parsed.todoId, parsed.name);
    const inline = /html|text|json|javascript|svg/i.test(file.contentType);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="${String(file.name || "file").replace(/"/g, "")}"`
    );
    return res.send(file.buffer);
  } catch (err) {
    return fail(res, err, err.status || 404);
  }
});

app.delete("/v1/me/todo-files/file", async (req, res) => {
  try {
    const ctx = await ownerFromStudent(req, res);
    if (!ctx) return;
    const parsed = parseTodoFileId(req.query.id) || {
      todoId: String(req.body?.todoId || req.query.todoId || "").trim(),
      name: String(req.body?.name || req.query.name || "").trim(),
    };
    return res.json(await deleteTodoFile(ctx.ownerId, parsed.todoId, parsed.name));
  } catch (err) {
    return fail(res, err, err.status || 404);
  }
});

app.get("/v1/agent/config", (_req, res) => {
  res.json(publicAgentConfig());
});

app.post("/v1/agent/chat", async (req, res) => {
  const student = await requireStudent(req, res);
  if (!student) return;

  const messages = sanitizeMessages(req.body?.messages);
  if (!messages.length) {
    return res.status(400).json({ error: "Send at least one user message." });
  }

  const useCursor = usesCursorAgent(student);
  const providerId = useCursor
    ? "cursor"
    : String(req.body?.provider || student.modelProvider || "groq");
  const provider = useCursor ? { id: "cursor", label: "Cursor" } : PROVIDERS[providerId];
  if (!provider) {
    return res.status(400).json({ error: "Unknown provider." });
  }

  const { keys, source } = useCursor
    ? { keys: ["cursor"], source: "cursor" }
    : resolveApiKeys(req, providerId, student);
  if (!keys.length) {
    return res.status(401).json({
      error: MISSING_KEY_ERROR,
    });
  }

  let snapshot = "";
  const ownerId = ownerIdForStudent(student);
  const writeSseHeaders = () => {
    if (res.headersSent) return;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("X-Agent-Source", source);
    res.setHeader("X-Agent-Provider", provider.id);
    res.flushHeaders?.();
  };
  const writeEvent = (payload) => {
    writeSseHeaders();
    if (payload === "[DONE]") {
      res.write("data: [DONE]\n\n");
      return;
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let keyAttempts = 1;
  const fetchUpstream = async (convo, { tools = true } = {}) => {
    const { response, attempts } = await fetchWithKeyCycle(keys, (useKey) =>
      fetch(provider.url, {
        method: "POST",
        headers: upstreamHeaders(provider, useKey),
        body: JSON.stringify(
          upstreamBody(provider, convo, snapshot, tools ? { tools: AGENT_TOOLS } : {})
        ),
        signal: AbortSignal.timeout(150_000),
      })
    );
    if (attempts) keyAttempts = attempts;
    if (!response) {
      const err = new Error("Could not reach the model host.");
      err.name = "FetchError";
      throw err;
    }
    return response;
  };

  const pipePlainStream = async (upstream) => {
    writeSseHeaders();
    if (!upstream.body) {
      writeEvent("[DONE]");
      return;
    }
    const decoder = new TextDecoder();
    let buf = "";
    const writeDelta = (event) => {
      if (!event || event === "[DONE]") return;
      let json;
      try {
        json = JSON.parse(event);
      } catch {
        return;
      }
      const delta = extractChatDelta(json);
      if (!delta.content && !delta.reasoning) return;
      writeEvent({ choices: [{ delta }] });
    };
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        buf = consumeSse(buf, writeDelta);
      }
      buf += decoder.decode();
      consumeSse(`${buf}\n\n`, writeDelta);
      writeEvent("[DONE]");
    } finally {
      reader.releaseLock();
    }
  };

  const readToolRound = async (upstream) => {
    if (!upstream.body) return { content: "", reasoning: "", toolCalls: [] };
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let reasoning = "";
    let toolCalls = [];
    const onEvent = (event) => {
      if (!event || event === "[DONE]") return;
      let json;
      try {
        json = JSON.parse(event);
      } catch {
        return;
      }
      const delta = extractChatDelta(json);
      if (delta.content) content += delta.content;
      if (delta.reasoning) {
        reasoning += delta.reasoning;
        writeEvent({ choices: [{ delta: { reasoning: delta.reasoning } }] });
      }
      toolCalls = mergeToolCallDeltas(toolCalls, extractToolCalls(json));
    };
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        buf = consumeSse(buf, onEvent);
      }
      buf += decoder.decode();
      consumeSse(`${buf}\n\n`, onEvent);
    } finally {
      reader.releaseLock();
    }
    if (!content && !reasoning && !toolCalls.length && buf.trim().startsWith("{")) {
      try {
        const json = JSON.parse(buf);
        const delta = extractChatDelta(json);
        content = delta.content || "";
        reasoning = delta.reasoning || "";
        toolCalls = mergeToolCallDeltas(toolCalls, extractToolCalls(json));
        if (reasoning) writeEvent({ choices: [{ delta: { reasoning } }] });
      } catch {
        /* leftover was not a full JSON body */
      }
    }
    return { content, reasoning, toolCalls: finishedToolCalls(toolCalls) };
  };

  let convo = messages.map((m) => ({ role: m.role, content: m.content }));
  const kinds = new Set();
  let navigate = null;

  const slimToolCalls = (calls) =>
    (calls || []).map((call) => {
      const fn = call?.function || {};
      let args = fn.arguments || "";
      if (typeof args === "string" && args.length > 240) {
        try {
          const parsed = JSON.parse(args);
          for (const key of ["content", "text", "html", "body"]) {
            if (typeof parsed[key] === "string" && parsed[key].length > 80) {
              parsed[key] = `[saved ${parsed[key].length} chars]`;
            }
          }
          args = JSON.stringify(parsed);
        } catch {
          args = `${args.slice(0, 239)}…`;
        }
      }
      return { ...call, function: { ...fn, arguments: args } };
    });

  const finishMutations = (content) => {
    if (kinds.size) writeEvent({ type: "mutation", kinds: [...kinds] });
    if (navigate) writeEvent({ type: "navigate", ...navigate, href: navigateHref(navigate) });
    if (content) writeEvent({ choices: [{ delta: { content } }] });
    writeEvent("[DONE]");
    return res.end();
  };

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    try {
      writeSseHeaders();
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 12_000);

  try {
    writeSseHeaders();
    writeEvent({ type: "status", text: "Thinking…" });
    try {
      snapshot = await liveSnapshot(student);
    } catch {
      snapshot = "";
    }
    const uiBlock = formatUiContextBlock(normalizeUiContext(req.body?.uiContext));
    if (uiBlock) {
      snapshot = snapshot ? `${snapshot}\n\n${uiBlock}` : uiBlock;
    }

    if (useCursor) {
      const cursorOut = await runCursorAgentChat({
        student,
        messages: convo,
        snapshot,
        ownerId,
        req,
        writeEvent,
      });
      for (const kind of cursorOut.kinds || []) kinds.add(kind);
      const nextNav = normalizeNavigate(cursorOut.navigate);
      if (nextNav) navigate = nextNav;
      return finishMutations(cursorOut.streamed ? "" : cursorOut.content || (kinds.size ? "Done" : ""));
    }

    for (let round = 0; round < 8; round += 1) {
      let upstream;
      try {
        upstream = await fetchUpstream(convo, { tools: true });
      } catch (err) {
        const timedOut = err && err.name === "TimeoutError";
        if (kinds.size) return finishMutations("Done");
        if (res.headersSent) {
          writeEvent({ choices: [{ delta: { content: timedOut ? "The model timed out. Try again." : "Could not reach the model host." } }] });
          writeEvent("[DONE]");
          return res.end();
        }
        return res.status(502).json({
          error: timedOut ? "The model timed out. Try again." : "Could not reach the model host.",
        });
      }

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        if (round === 0 && /tool/i.test(text)) {
          let fallback;
          try {
            fallback = await fetchUpstream(convo, { tools: false });
          } catch {
            fallback = null;
          }
          if (fallback?.ok) {
            await pipePlainStream(fallback);
            return res.end();
          }
        }
        if (kinds.size) return finishMutations("Done");
        const errExtras = {
          keyCount: keys.length,
          attempts: keyAttempts,
          source,
          provider: provider.id,
        };
        const message = explainUpstreamError(upstream.status, text, errExtras);
        const code = upstreamErrorCode(upstream.status, text);
        if (res.headersSent) {
          writeEvent({ type: "error", code, text: message });
          writeEvent({ choices: [{ delta: { content: message } }] });
          writeEvent("[DONE]");
          return res.end();
        }
        return res.status(upstream.status === 401 ? 401 : 502).json({
          error: message,
          code,
        });
      }

      const roundOut = await readToolRound(upstream);
      if (!roundOut.toolCalls.length) {
        return finishMutations(roundOut.content || (kinds.size ? "Done" : ""));
      }

      writeSseHeaders();
      writeEvent({ type: "status", text: "Working…" });
      convo.push({
        role: "assistant",
        content: roundOut.content || "",
        tool_calls: slimToolCalls(roundOut.toolCalls),
      });
      for (const call of roundOut.toolCalls) {
        const result = await executeAgentTool(call, { ownerId, student, req });
        (result.kinds || []).forEach((k) => kinds.add(k));
        const nextNav = normalizeNavigate(result.navigate);
        if (nextNav) navigate = nextNav;
        convo.push({
          role: "tool",
          tool_call_id: call.id || `call_${round}`,
          content: result.text,
        });
      }
    }
    return finishMutations(kinds.size ? "Done" : "Stopped after too many tool steps.");
  } catch {
    if (kinds.size) {
      try {
        return finishMutations("Done");
      } catch {
        return res.end();
      }
    }
    if (!res.headersSent) {
      return res.status(502).json({ error: "Could not reach the model host." });
    }
    try {
      writeEvent("[DONE]");
    } catch {
      /* hung up */
    }
    return res.end();
  } finally {
    clearInterval(heartbeat);
  }
});

async function requireChatOwner(req, res) {
  const student = await requireStudent(req, res);
  if (!student) return null;
  const ownerId = ownerIdForStudent(student);
  if (!ownerId) {
    res.status(401).json({ error: "Sign in with Google first." });
    return null;
  }
  return ownerId;
}

app.get("/v1/agent/chats", async (req, res) => {
  try {
    const ownerId = await requireChatOwner(req, res);
    if (!ownerId) return;
    return res.json({ chats: await listChats(ownerId) });
  } catch (err) {
    return fail(res, err, err.status || 500);
  }
});

app.post("/v1/agent/chats", async (req, res) => {
  try {
    const ownerId = await requireChatOwner(req, res);
    if (!ownerId) return;
    const chat = await persistChat({
      ownerId,
      sessionId: req.body?.sessionId,
      messages: req.body?.messages,
      title: req.body?.title,
    });
    return res.json({
      sessionId: chat.sessionId,
      title: chat.title,
      preview: chat.preview,
      started: chat.started,
      updated: chat.updated,
      unread: chatHistoryIsUnread(chat.updated, chat.lastRead),
    });
  } catch (err) {
    return fail(res, err, err.status || 400);
  }
});

app.get("/v1/agent/chats/:id", async (req, res) => {
  try {
    const ownerId = await requireChatOwner(req, res);
    if (!ownerId) return;
    return res.json(await loadChat(ownerId, req.params.id));
  } catch (err) {
    return fail(res, err, err.status || 404);
  }
});

app.post("/v1/agent/chats/:id/read", async (req, res) => {
  try {
    const ownerId = await requireChatOwner(req, res);
    if (!ownerId) return;
    return res.json(await markChatRead(ownerId, req.params.id));
  } catch (err) {
    return fail(res, err, err.status || 404);
  }
});

mountSchedule(app, {
  requireStudent,
  fail,
  upload: pdfUpload,
});
mountNotes(app, { requireStudent, fail });
mountResearch(app, { fail });
// EPS door: Canvas via the school's Developer Key, schedule via the four11 API.
// Both are off until IT hands over the keys (docs/IT_REQUEST.md).
mountCanvasOAuth(app);
mountFour11(app);

app.listen(PORT, HOST, () => {
  console.log(`[jype-server] listening on http://${HOST}:${PORT}`);
  console.log(`[ms-oauth] Microsoft sign-in ${msConfigured() ? "on (auth code + PKCE)" : "off: MICROSOFT_CLIENT_ID is unset"}`);
  void purgeForeignMicrosoftTokensAtBoot();
});
