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
  explainUpstreamError,
  publicAgentConfig,
  resolveApiKey,
  sanitizeMessages,
  upstreamBody,
  upstreamHeaders,
} from "./agent.js";
import {
  dashboardPayload,
  listAssignments,
  listCourses,
  normalizeHost,
  validateToken,
} from "./canvas.js";
import {
  acceptPastedToken,
  downloadFile,
  ensureFreshToken,
  isConnected,
  listFiles,
  pollDeviceCode,
  publicPending,
  startDeviceCode,
  uploadFile,
  WRITE_FOLDER,
} from "./onedrive.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  mergeGraph,
  publicProfile,
  safeFileId,
  saveStudent,
  setSessionCookie,
  studentFromRequest,
  upsertStudent,
} from "./students.js";

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
      error: "Open settings and save your school and student ID first.",
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

async function graphToken(student) {
  const fresh = await ensureFreshToken(student.graph);
  if (fresh !== student.graph) {
    mergeGraph(student, fresh);
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
      bits.push(`Courses: ${courses.join("; ") || "none listed"}`);
      bits.push(`Open work: ${open.join("; ") || "none"}`);
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

  return bits.join("\n").slice(0, 4000);
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "jype-server",
    time: new Date().toISOString(),
  });
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
    const school = String(req.body?.school || "Eastside Prep").trim();
    const studentId = String(req.body?.studentId || "").trim();
    const canvasHost = req.body?.canvasHost
      ? normalizeHost(req.body.canvasHost)
      : undefined;
    const pasted = String(req.body?.canvasToken || "").trim();
    const canvasToken = pasted || undefined;

    let displayName;
    if (canvasToken) {
      const self = await validateToken(canvasHost || "", canvasToken);
      displayName = self.displayName;
    }

    const student = await upsertStudent({
      school,
      studentId,
      canvasHost,
      canvasToken,
      displayName,
    });
    const sid = createSession(safeFileId(student.school, student.studentId));
    return sessionJson(req, res, student, sid);
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
        message: started.message,
      },
    });
    return res.json({
      user_code: started.user_code,
      verification_uri: started.verification_uri,
      verification_uri_complete: started.verification_uri_complete || "",
      message: started.message,
      interval: started.interval,
    });
  } catch (err) {
    return fail(res, err);
  }
});

app.get("/v1/me/onedrive/status", async (req, res) => {
  try {
    const student = await requireStudent(req, res);
    if (!student) return;
    const pending = student.graph?.pending;
    if (pending?.device_code) {
      const poll = await pollDeviceCode(pending.device_code);
      if (poll.ok) {
        await persistGraph(student, {
          accessToken: poll.accessToken,
          refreshToken: poll.refreshToken,
          exp: poll.exp,
          email: poll.email,
          pending: null,
        });
      } else if (!poll.pending) {
        await persistGraph(student, { pending: null });
      }
    }
    return res.json({
      connected: isConnected(student.graph),
      pending: publicPending(student.graph),
      email: student.graph?.email || "",
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
  const providerId = String(req.body?.provider || "groq");
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return res.status(400).json({ error: "Unknown provider." });
  }

  const messages = sanitizeMessages(req.body?.messages);
  if (!messages.length) {
    return res.status(400).json({ error: "Send at least one user message." });
  }

  const { key, source } = resolveApiKey(req, providerId);
  if (!key) {
    return res.status(401).json({
      error:
        "Paste a free API key first. Groq is the fastest signup: console.groq.com/keys",
    });
  }

  let snapshot = "";
  try {
    const student = await studentFromRequest(req);
    if (student) snapshot = await liveSnapshot(student);
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
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Agent-Source", source);
  res.setHeader("X-Agent-Provider", provider.id);
  res.flushHeaders?.();

  if (!upstream.body) {
    return res.end();
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // Client hung up or the upstream stream died. Fine.
  } finally {
    reader.releaseLock();
    res.end();
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[jype-server] listening on http://${HOST}:${PORT}`);
});
