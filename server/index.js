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
  publicAgentConfig,
  MISSING_KEY_ERROR,
  resolveApiKey,
  sanitizeMessages,
  upstreamBody,
  upstreamHeaders,
} from "./agent.js";
import {
  dashboardPayload,
  listAssignments,
  listCourses,
  listGrades,
  normalizeHost,
  validateToken,
} from "./canvas.js";
import {
  acceptPastedToken,
  completeDeviceUrl,
  downloadFile,
  ensureFreshToken,
  isConnected,
  listFiles,
  pollDeviceCode,
  publicPending,
  startDeviceCode,
  tokenHasFiles,
  tokenHasMail,
  uploadFile,
  WRITE_FOLDER,
} from "./onedrive.js";
import { publicGoogleConfig, verifyIdToken } from "./google.js";
import {
  acceptPastedToken as acceptOutlookToken,
  ensureFreshToken as ensureOutlookToken,
  isConnected as outlookConnected,
  listMessages,
  pollDeviceCode as pollOutlookCode,
  publicPending as outlookPending,
  readMessage,
  sendMessage,
  startDeviceCode as startOutlookCode,
} from "./outlook.js";
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
import { mountNotes } from "./notes.js";
import { mountResearch } from "./research-metrics.js";
import { mountSchedule } from "./schedule.js";

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

function sessionJson(req, res, student, sid) {
  if (sid) setSessionCookie(req, res, sid);
  return res.json({
    ...publicProfile(student),
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
  };
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
  const files = tokenHasFiles(poll.accessToken);
  const mail = tokenHasMail(poll.accessToken);
  if (files) await persistGraph(current, bag);
  if (mail) await persistOutlook(current, bag);
  if (!files && !mail) await persistGraph(current, bag);
  console.log(
    `[ms-oauth] token for ${bag.email || "unknown"} files=${files} mail=${mail}`
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
        .filter((c) => c.currentGrade || c.currentScore != null)
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

  if (student.graph?.accessToken) {
    try {
      const token = await graphToken(student);
      const files = await listFiles(token, { folder: WRITE_FOLDER });
      const names = (files || []).map((f) => f.name).filter(Boolean).slice(0, 12);
      bits.push(`OneDrive /EPSynapse: ${names.join("; ") || "empty"}`);
    } catch {
      bits.push("OneDrive: could not list /EPSynapse this turn.");
    }
  } else {
    bits.push("OneDrive: not connected.");
  }

  if (student.outlook?.accessToken) {
    try {
      const token = await outlookToken(student);
      const inbox = await listMessages(token, { limit: 8 });
      const lines = (inbox || []).map((m) => {
        const when = String(m.received || "").slice(0, 16);
        const flag = m.unread ? "unread" : "read";
        return `${when} ${flag} ${m.fromAddress || m.from}: ${m.subject}`;
      });
      bits.push(`Outlook inbox: ${lines.join(" | ") || "empty"}`);
    } catch {
      bits.push("Outlook: could not read inbox this turn.");
    }
  } else {
    bits.push("Outlook: not connected.");
  }

  return bits.join("\n").slice(0, 4000);
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
    return res.json(publicProfile(student));
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
    return res.json(publicProfile(student));
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
    return res.json({ courses });
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.get("/v1/me/canvas/assignments", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    if (!student.canvasToken) {
      return res.status(400).json({ error: "Connect Canvas in settings first." });
    }
    const assignments = await listAssignments(student.canvasHost, student.canvasToken);
    return res.json({ assignments });
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
    return res.json({ grades });
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
    return res.json({
      connected: isConnected(current.graph),
      pending: publicPending(current.graph),
      email: current.graph?.email || "",
      error: pollError || "",
      outlookConnected: outlookConnected(current.outlook),
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
    if (!student.graph?.accessToken) {
      return res.status(400).json({ error: "Connect OneDrive in settings first." });
    }
    const token = await graphToken(student);
    const folder = String(req.query.folder || WRITE_FOLDER);
    const files = await listFiles(token, { folder });
    return res.json({ files, folder });
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.get("/v1/me/onedrive/file", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    if (!student.graph?.accessToken) {
      return res.status(400).json({ error: "Connect OneDrive in settings first." });
    }
    const token = await graphToken(student);
    const file = await downloadFile(token, req.query.id);
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
    return res.json({
      connected: outlookConnected(current.outlook),
      pending: outlookPending(current.outlook),
      email: current.outlook?.email || "",
      error: pollError || "",
      onedriveConnected: isConnected(current.graph),
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
    if (!student.outlook?.accessToken) {
      return res.status(400).json({ error: "Connect Outlook in settings first." });
    }
    const token = await outlookToken(student);
    const search = String(req.query.q || "").trim();
    const limit = Number(req.query.limit) || 20;
    const messages = await listMessages(token, { search, limit });
    return res.json({ messages });
  } catch (err) {
    return fail(res, err, err.status || 502);
  }
});

app.get("/v1/me/outlook/message", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    if (!student.outlook?.accessToken) {
      return res.status(400).json({ error: "Connect Outlook in settings first." });
    }
    const token = await outlookToken(student);
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
    if (!student.outlook?.accessToken) {
      return res.status(400).json({ error: "Connect Outlook in settings first." });
    }
    const token = await outlookToken(student);
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

app.put("/v1/me/onedrive/file", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    if (!student.graph?.accessToken) {
      return res.status(400).json({ error: "Connect OneDrive in settings first." });
    }
    const token = await graphToken(student);
    const name = String(req.body?.name || "").trim();
    let content = req.body?.content;
    if (req.body?.encoding === "base64") {
      content = Buffer.from(String(content || ""), "base64");
    }
    const saved = await uploadFile(token, {
      name,
      content,
      contentType: String(req.body?.contentType || "text/plain"),
    });
    return res.json(saved);
  } catch (err) {
    return fail(res, err, err.status || 400);
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

  let upstream;
  try {
    upstream = await fetch(provider.url, {
      method: "POST",
      headers: upstreamHeaders(provider, key),
      body: JSON.stringify(upstreamBody(provider, messages, snapshot)),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    const timedOut = err && err.name === "TimeoutError";
    return res.status(502).json({
      error: timedOut ? "The model timed out. Try again." : "Could not reach the model host.",
    });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return res.status(upstream.status === 401 ? 401 : 502).json({
      error: explainUpstreamError(upstream.status, text),
    });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Content-Encoding", "identity");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Agent-Source", source);
  res.setHeader("X-Agent-Provider", provider.id);
  res.flushHeaders?.();

  if (!upstream.body) {
    return res.end();
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
    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
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
    res.write("data: [DONE]\n\n");
  } catch {
    // Client hung up or the upstream stream died. Fine.
  } finally {
    reader.releaseLock();
    res.end();
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
