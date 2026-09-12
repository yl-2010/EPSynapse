/**
 * JYPE / EPSynapse Mac Express API.
 * Cloudflare Tunnel to this process. Port 3006. Leave 3000 / 3002 / 3004 alone.
 *
 * Port 3006 — public hostname api.epsynapse.com (own tunnel).
 */

import express from "express";
import cors from "cors";
import {
  PROVIDERS,
  consumeSse,
  explainUpstreamError,
  extractChatDelta,
  extractToolCalls,
  finishedToolCalls,
  formatUiContextBlock,
  mergeToolCallDeltas,
  normalizeUiContext,
  publicAgentConfig,
  MISSING_KEY_ERROR,
  resolveApiKey,
  sanitizeMessages,
  upstreamBody,
  upstreamHeaders,
} from "./agent.js";
import { AGENT_TOOLS, executeAgentTool, navigateHref, normalizeNavigate } from "./agent-tools.js";
import {
  applyScheduleToGrades,
  dashboardPayload,
  isNonGradeCourse,
  listAssignments,
  listCourses,
  listGrades,
  markAssignmentComplete,
  markAssignmentIncomplete,
  normalizeHost,
  validateToken,
} from "./canvas.js";
import {
  acceptPastedToken,
  completeDeviceUrl,
  downloadFile,
  ensureFreshToken,
  isConnected,
  listDashboardFiles,
  pollDeviceCode,
  probeGraph,
  publicPending,
  searchFiles,
  startDeviceCode,
  uploadFile,
  WRITE_FOLDER,
} from "./onedrive.js";
import { publicGoogleConfig, verifyIdToken } from "./google.js";
import {
  acceptPastedToken as acceptOutlookToken,
  ensureFreshToken as ensureOutlookToken,
  isConnected as outlookConnected,
  listEvents,
  listMessages,
  pollDeviceCode as pollOutlookCode,
  publicPending as outlookPending,
  readMessage,
  sendMessage,
  startDeviceCode as startOutlookCode,
} from "./outlook.js";
import {
  adminConsentUrl,
  acceptPastedToken as acceptTeamsToken,
  ensureFreshToken as ensureTeamsToken,
  isConnected as teamsGraphConnected,
  listChats as listTeamsChats,
  listChatMessages as listTeamsMessages,
  pollDeviceCode as pollTeamsCode,
  publicPending as teamsPending,
  sendChatMessage as sendTeamsGraph,
  startDeviceCode as startTeamsCode,
} from "./teams.js";
import {
  isStudioDemoStudent,
  listStudioChatMessages,
  listStudioChats,
  listStudioFiles,
  readStudioFile,
  sendStudioChat,
  studioFlags,
  studioOutlookToken,
  writeStudioFile,
} from "./studio-ms.js";
import { listVault, readVault, saveVault } from "./vault.js";
import {
  getSchool,
  listSchools,
  lookupRosterName,
  publicSchool,
  resolveSchool,
  setRoster,
} from "./schools.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  googleFileId,
  loadStudentByFileId,
  mergeGraph,
  mergeOutlook,
  mergeTeams,
  publicProfile,
  saveStudent,
  sessionIdFromRequest,
  setSessionCookie,
  studentFromRequest,
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
import { probeBertService } from "./bert.js";
import { listNotes, mountNotes } from "./notes.js";
import { mountResearch } from "./research-metrics.js";
import { loadSchedule, mountSchedule } from "./schedule.js";
import {
  applyClassAliases,
  hideCanvasTodo,
  isLocalTodoId,
  listAllClassFiles,
  listClassFiles,
  listTodos,
  loadWorkspaceMeta,
  mergeAssignments,
  parseClassFileId,
  patchTodo,
  readClassFile,
  renameClass,
  writeClassFile,
  deleteClassFile,
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
  return student;
}

function publicMe(student) {
  const flags = studioFlags(student);
  const base = publicProfile(student);
  return {
    ...base,
    onedriveConnected: Boolean(base.onedriveConnected || flags.onedrive),
    outlookConnected: Boolean(base.outlookConnected || flags.outlook),
    teamsConnected: Boolean(base.teamsConnected || flags.teams),
    studioOnedrive: flags.onedrive,
    studioOutlook: flags.outlook,
    studioTeams: flags.teams,
    adminConsentUrl: adminConsentUrl(),
  };
}

function sessionJson(req, res, student, sid) {
  if (sid) setSessionCookie(req, res, sid);
  return res.json({
    ...publicMe(student),
    sessionId: sid || "",
  });
}

async function persistGraph(student, patch) {
  mergeGraph(student, patch);
  return saveStudent(student);
}

async function persistOutlook(student, patch) {
  mergeOutlook(student, patch);
  return saveStudent(student);
}

async function persistTeams(student, patch) {
  mergeTeams(student, patch);
  return saveStudent(student);
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

function waitingDeviceError(error) {
  const e = String(error || "");
  return e === "authorization_pending" || e === "slow_down";
}

function terminalDeviceError(error) {
  const e = String(error || "").toLowerCase();
  return (
    e === "expired_token" ||
    e === "authorization_declined" ||
    e === "access_denied" ||
    e === "bad_verification_code" ||
    e === "invalid_grant" ||
    e.includes("aadsts70016") ||
    e.includes("aadsts65001") ||
    e.includes("aadsts65002") ||
    e.includes("expired") ||
    e.includes("declined")
  );
}

const BROKEN_OUTLOOK_WEB_CLIENT = "9199bf20-a13f-4107-85dc-02114787ef48";

function livePending(pending) {
  if (!pending?.device_code || !pending.user_code) return null;
  if (String(pending.clientId || "") === BROKEN_OUTLOOK_WEB_CLIENT) return null;
  const exp = Number(pending.expiresAt) || 0;
  if (exp && exp < Date.now()) return null;
  return pending;
}

function pendingStartPayload(pending) {
  const user_code = pending.user_code || "";
  const verification_uri = pending.verification_uri || "https://login.microsoft.com/device";
  return {
    user_code,
    verification_uri,
    verification_uri_complete:
      pending.verification_uri_complete || completeDeviceUrl(user_code, verification_uri),
    message: pending.message || "",
    interval: pending.interval || 5,
    adminConsentUrl: adminConsentUrl(),
  };
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

async function applyMicrosoftToken(current, poll, pending) {
  const bag = {
    accessToken: poll.accessToken,
    refreshToken: poll.refreshToken,
    exp: poll.exp,
    email: poll.email,
    clientId: poll.clientId || pending?.clientId || "",
    scope: poll.scope || pending?.scope || "",
    pending: null,
  };
  let probe = { user: false, files: false, mail: false, calendar: false, email: "", error: "" };
  try {
    probe = await probeGraph(poll.accessToken);
  } catch (err) {
    probe.error = shortMsError(err);
  }
  if (probe.email) bag.email = probe.email;
  const files = Boolean(probe.files || probe.user);
  const mail = Boolean(probe.mail || probe.user);
  let chats = false;
  try {
    await listTeamsChats(poll.accessToken, { limit: 1 });
    chats = true;
  } catch {
    chats = false;
  }
  if (files) await persistGraph(current, bag);
  if (mail) await persistOutlook(current, bag);
  if (chats) await persistTeams(current, bag);
  if (!files && !mail && !chats) await persistGraph(current, bag);
  console.log(
    `[ms-oauth] probe email=${bag.email || ""} files=${probe.files} mail=${probe.mail} calendar=${probe.calendar} chats=${chats}`
  );
}

async function graphToken(student) {
  const fresh = await ensureFreshToken(student.graph);
  if (fresh !== student.graph) {
    mergeGraph(student, fresh);
    await saveStudent(student);
  }
  return fresh.accessToken;
}

async function outlookToken(student) {
  const fresh = await ensureOutlookToken(student.outlook);
  if (fresh !== student.outlook) {
    mergeOutlook(student, fresh);
    await saveStudent(student);
  }
  return fresh.accessToken;
}

async function teamsToken(student) {
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
      const courses = (dash.courses || []).map((c) => c.name).filter(Boolean).slice(0, 12);
      const open = (dash.assignments || [])
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
    "You can add, edit, check off, and delete notes and todos, add HTML or other files to a class, and rename classes. You can also list and write OneDrive files, read and send Outlook, and read and send Teams when those are connected. Use the tools."
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

    const patch = {};
    if (req.body?.school !== undefined) patch.school = req.body.school;
    if (req.body?.studentId !== undefined) patch.studentId = req.body.studentId;
    if (req.body?.canvasHost) patch.canvasHost = normalizeHost(req.body.canvasHost);

    const pasted = String(req.body?.canvasToken || "").trim();
    if (pasted) {
      const self = await validateToken(patch.canvasHost || student.canvasHost, pasted);
      patch.canvasToken = pasted;
      if (self.displayName) patch.displayName = self.displayName;
    }

    let updated = await updateStudentProfile(student, patch);
    const schoolChanged =
      req.body?.school !== undefined || req.body?.studentId !== undefined;

    if (updated.school && updated.studentId) {
      const school = await resolveSchool(updated.school);
      const rosterName = school
        ? await lookupRosterName(school.slug, updated.studentId)
        : "";
      updated = await updateStudentProfile(updated, {
        rosterName,
        rosterMatched: Boolean(rosterName),
        displayName: rosterName || updated.displayName || updated.googleName,
      });
    } else if (schoolChanged) {
      updated = await updateStudentProfile(updated, {
        rosterName: "",
        rosterMatched: false,
      });
    }

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
      patch.modelKey = "";
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
    const meta = ownerId ? await loadWorkspaceMeta(ownerId).catch(() => ({ hiddenTodoIds: [] })) : { hiddenTodoIds: [] };
    return res.json({ assignments: mergeAssignments(canvas, local, meta.hiddenTodoIds) });
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
    if (!student.canvasToken) {
      return res.status(400).json({ error: "Connect Canvas in settings first." });
    }
    const saved = await markAssignmentComplete(student.canvasHost, student.canvasToken, {
      id: req.params.id,
      canvasId: req.body?.canvasId || req.params.id,
      plannerOverrideId: req.body?.plannerOverrideId,
      plannableType: req.body?.plannableType,
    });
    return res.json(saved);
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
    if (!student.canvasToken) {
      return res.status(400).json({ error: "Connect Canvas in settings first." });
    }
    const saved = await markAssignmentIncomplete(student.canvasHost, student.canvasToken, {
      id: req.params.id,
      canvasId: req.body?.canvasId || req.params.id,
      plannerOverrideId: req.body?.plannerOverrideId,
      plannableType: req.body?.plannableType,
    });
    return res.json(saved);
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

app.post("/v1/me/onedrive/start", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const started = await startDeviceCode();
    if (!started.ok) {
      return res.json({
        user_code: "",
        verification_uri: "",
        message: started.error || "Microsoft would not start school sign-in.",
        adminConsentUrl: adminConsentUrl(),
      });
    }
    await persistGraph(student, {
      pending: {
        device_code: started.device_code,
        clientId: started.clientId,
        interval: started.interval,
        expiresAt: started.expiresAt,
        user_code: started.user_code,
        verification_uri: started.verification_uri,
        verification_uri_complete: started.verification_uri_complete || "",
        message: started.message,
      },
    });
    return res.json(pendingStartPayload(started));
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/me/onedrive/status", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const fileId = googleFileId(student.googleSub);
    const { current, pollError } = await withStudentLock(fileId, async () => {
      const current = (await loadStudentByFileId(fileId)) || student;
      const pending = current.graph?.pending;
      if (!pending?.device_code) return { current, pollError: "" };
      if (!livePending(pending)) {
        await persistGraph(current, { pending: null });
        return { current, pollError: "That Microsoft sign-in expired. Connect again." };
      }
      const poll = await pollDeviceCode(pending.device_code, pending.clientId);
      if (poll.ok) {
        await applyMicrosoftToken(current, poll, pending);
        return { current, pollError: "" };
      }
      if (poll.pending || waitingDeviceError(poll.error)) {
        return { current, pollError: "" };
      }
      console.warn("[ms-oauth] onedrive poll", poll.error);
      if (terminalDeviceError(poll.error)) {
        await persistGraph(current, { pending: null });
        return { current, pollError: poll.error };
      }
      return { current, pollError: poll.error || "" };
    });
    const flags = studioFlags(current);
    return res.json({
      connected: isConnected(current.graph) || flags.onedrive,
      pending: publicPending(current.graph),
      email: current.graph?.email || "",
      error: pollError || "",
      studio: flags.onedrive,
      adminConsentUrl: adminConsentUrl(),
      outlookConnected: outlookConnected(current.outlook) || flags.outlook,
      outlookEmail: current.outlook?.email || "",
    });
  } catch (err) {
    return fail(res, err);
  }
});

app.post("/v1/me/onedrive/token", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const accepted = acceptPastedToken(req.body?.accessToken);
    if (!accepted.ok) {
      return res.status(400).json({ error: accepted.error || "That token is not a Graph token." });
    }
    await persistGraph(student, {
      accessToken: accepted.accessToken,
      refreshToken: accepted.refreshToken,
      exp: accepted.exp,
      email: accepted.email,
      pending: null,
    });
    return res.json({
      connected: true,
      email: accepted.email,
      pending: null,
    });
  } catch (err) {
    return fail(res, err, 400);
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

app.post("/v1/me/outlook/start", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const started = await startOutlookCode();
    if (!started.ok) {
      return res.json({
        user_code: "",
        verification_uri: "",
        message: started.error || "Microsoft would not start Outlook sign-in.",
        adminConsentUrl: adminConsentUrl(),
      });
    }
    await persistOutlook(student, {
      pending: {
        device_code: started.device_code,
        clientId: started.clientId,
        scope: started.scope,
        interval: started.interval,
        expiresAt: started.expiresAt,
        user_code: started.user_code,
        verification_uri: started.verification_uri,
        verification_uri_complete: started.verification_uri_complete || "",
        message: started.message,
      },
    });
    return res.json(pendingStartPayload(started));
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/me/outlook/status", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const fileId = googleFileId(student.googleSub);
    const { current, pollError } = await withStudentLock(fileId, async () => {
      const current = (await loadStudentByFileId(fileId)) || student;
      const pending = current.outlook?.pending;
      if (!pending?.device_code) return { current, pollError: "" };
      if (!livePending(pending)) {
        await persistOutlook(current, { pending: null });
        return { current, pollError: "That Microsoft sign-in expired. Connect again." };
      }
      const poll = await pollOutlookCode(pending.device_code, pending.clientId);
      if (poll.ok) {
        await applyMicrosoftToken(current, poll, pending);
        return { current, pollError: "" };
      }
      if (poll.pending || waitingDeviceError(poll.error)) {
        return { current, pollError: "" };
      }
      console.warn("[ms-oauth] outlook poll", poll.error);
      if (terminalDeviceError(poll.error)) {
        await persistOutlook(current, { pending: null });
        return { current, pollError: poll.error };
      }
      return { current, pollError: poll.error || "" };
    });
    const flags = studioFlags(current);
    return res.json({
      connected: outlookConnected(current.outlook) || flags.outlook,
      pending: outlookPending(current.outlook),
      email: current.outlook?.email || "",
      error: pollError || "",
      studio: flags.outlook,
      adminConsentUrl: adminConsentUrl(),
      onedriveConnected: isConnected(current.graph) || flags.onedrive,
      onedriveEmail: current.graph?.email || "",
    });
  } catch (err) {
    return fail(res, err);
  }
});

app.post("/v1/me/outlook/token", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const accepted = acceptOutlookToken(req.body?.accessToken);
    if (!accepted.ok) {
      return res.status(400).json({ error: accepted.error || "That token is not an Outlook token." });
    }
    await persistOutlook(student, {
      accessToken: accepted.accessToken,
      refreshToken: accepted.refreshToken,
      exp: accepted.exp,
      email: accepted.email,
      clientId: accepted.clientId,
      scope: accepted.scope,
      pending: null,
    });
    return res.json({
      connected: true,
      email: accepted.email,
      pending: null,
    });
  } catch (err) {
    return fail(res, err, 400);
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
    const student = await requireStudent(req, res);
    if (!student) return;
    const started = await startTeamsCode();
    if (!started.ok) {
      return res.json({
        user_code: "",
        verification_uri: "",
        message: started.error || "Microsoft would not start Teams sign-in.",
        adminConsentUrl: started.adminConsentUrl || adminConsentUrl(),
      });
    }
    await persistTeams(student, {
      pending: {
        device_code: started.device_code,
        clientId: started.clientId,
        scope: started.scope,
        interval: started.interval,
        expiresAt: started.expiresAt,
        user_code: started.user_code,
        verification_uri: started.verification_uri,
        verification_uri_complete: started.verification_uri_complete || "",
        message: started.message,
      },
    });
    return res.json(pendingStartPayload(started));
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/me/teams/status", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const fileId = googleFileId(student.googleSub);
    const { current, pollError } = await withStudentLock(fileId, async () => {
      const current = (await loadStudentByFileId(fileId)) || student;
      const pending = current.teams?.pending;
      if (!pending?.device_code) return { current, pollError: "" };
      if (!livePending(pending)) {
        await persistTeams(current, { pending: null });
        return { current, pollError: "That Microsoft sign-in expired. Connect again." };
      }
      const poll = await pollTeamsCode(pending.device_code, pending.clientId);
      if (poll.ok) {
        await persistTeams(current, {
          accessToken: poll.accessToken,
          refreshToken: poll.refreshToken,
          exp: poll.exp,
          email: poll.email,
          clientId: poll.clientId || pending.clientId,
          scope: poll.scope || pending.scope,
          pending: null,
        });
        return { current, pollError: "" };
      }
      if (poll.pending || waitingDeviceError(poll.error)) {
        return { current, pollError: "" };
      }
      console.warn("[ms-oauth] teams poll", poll.error);
      if (terminalDeviceError(poll.error)) {
        await persistTeams(current, { pending: null });
        return { current, pollError: poll.error };
      }
      return { current, pollError: poll.error || "" };
    });
    const flags = studioFlags(current);
    return res.json({
      connected: teamsGraphConnected(current.teams) || flags.teams,
      pending: teamsPending(current.teams),
      email: current.teams?.email || "",
      error: pollError || "",
      studio: flags.teams,
      adminConsentUrl: adminConsentUrl(),
    });
  } catch (err) {
    return fail(res, err);
  }
});

app.post("/v1/me/teams/token", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const accepted = acceptTeamsToken(req.body?.accessToken);
    if (!accepted.ok) {
      return res.status(400).json({ error: accepted.error || "That token is not a Teams token." });
    }
    await persistTeams(student, {
      accessToken: accepted.accessToken,
      refreshToken: accepted.refreshToken,
      exp: accepted.exp,
      email: accepted.email,
      clientId: accepted.clientId,
      scope: accepted.scope,
      pending: null,
    });
    return res.json({ connected: true, email: accepted.email, pending: null });
  } catch (err) {
    return fail(res, err, 400);
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

app.get("/v1/agent/config", (_req, res) => {
  res.json(publicAgentConfig());
});

app.post("/v1/agent/chat", async (req, res) => {
  const student = await requireStudent(req, res);
  if (!student) return;

  const providerId = String(req.body?.provider || student.modelProvider || "groq");
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return res.status(400).json({ error: "Unknown provider." });
  }

  const messages = sanitizeMessages(req.body?.messages);
  if (!messages.length) {
    return res.status(400).json({ error: "Send at least one user message." });
  }

  const { key, source } = resolveApiKey(req, providerId, student);
  if (!key) {
    return res.status(401).json({
      error: MISSING_KEY_ERROR,
    });
  }

  let snapshot = "";
  try {
    snapshot = await liveSnapshot(student);
  } catch {
    snapshot = "";
  }
  const uiBlock = formatUiContextBlock(normalizeUiContext(req.body?.uiContext));
  if (uiBlock) {
    snapshot = snapshot ? `${snapshot}\n\n${uiBlock}` : uiBlock;
  }

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

  const fetchUpstream = async (convo, { tools = true } = {}) => {
    return fetch(provider.url, {
      method: "POST",
      headers: upstreamHeaders(provider, key),
      body: JSON.stringify(
        upstreamBody(provider, convo, snapshot, tools ? { tools: AGENT_TOOLS } : {})
      ),
      signal: AbortSignal.timeout(90_000),
    });
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
      if (delta.reasoning) reasoning += delta.reasoning;
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
      } catch {
        /* leftover was not a full JSON body */
      }
    }
    return { content, reasoning, toolCalls: finishedToolCalls(toolCalls) };
  };

  let convo = messages.map((m) => ({ role: m.role, content: m.content }));
  const kinds = new Set();
  let navigate = null;

  try {
    for (let round = 0; round < 8; round += 1) {
      let upstream;
      try {
        upstream = await fetchUpstream(convo, { tools: true });
      } catch (err) {
        const timedOut = err && err.name === "TimeoutError";
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
        if (res.headersSent) {
          writeEvent({ choices: [{ delta: { content: explainUpstreamError(upstream.status, text) } }] });
          writeEvent("[DONE]");
          return res.end();
        }
        return res.status(upstream.status === 401 ? 401 : 502).json({
          error: explainUpstreamError(upstream.status, text),
        });
      }

      const roundOut = await readToolRound(upstream);
      if (!roundOut.toolCalls.length) {
        if (kinds.size) writeEvent({ type: "mutation", kinds: [...kinds] });
        if (navigate) writeEvent({ type: "navigate", ...navigate, href: navigateHref(navigate) });
        if (roundOut.reasoning) writeEvent({ choices: [{ delta: { reasoning: roundOut.reasoning } }] });
        if (roundOut.content) writeEvent({ choices: [{ delta: { content: roundOut.content } }] });
        writeEvent("[DONE]");
        return res.end();
      }

      writeSseHeaders();
      writeEvent({ type: "status", text: "Working…" });
      convo.push({
        role: "assistant",
        content: roundOut.content || "",
        tool_calls: roundOut.toolCalls,
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
    if (kinds.size) writeEvent({ type: "mutation", kinds: [...kinds] });
    if (navigate) writeEvent({ type: "navigate", ...navigate, href: navigateHref(navigate) });
    writeEvent({ choices: [{ delta: { content: "Stopped after too many tool steps." } }] });
    writeEvent("[DONE]");
    return res.end();
  } catch {
    if (!res.headersSent) {
      return res.status(502).json({ error: "Could not reach the model host." });
    }
    try {
      writeEvent("[DONE]");
    } catch {
      /* hung up */
    }
    return res.end();
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

app.listen(PORT, HOST, () => {
  console.log(`[jype-server] listening on http://${HOST}:${PORT}`);
});
