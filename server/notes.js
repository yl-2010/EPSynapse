/**
 * Student notes + research events for the EPSynapse notes classifier.
 * Research events never store full note text. Metrics never return raw notes.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ownerIdForStudent } from "./chat-history.js";
import { isHiddenClassCourse, listCourses } from "./canvas.js";
import { classifyEnsemble } from "./classify.js";
import { loadSchedule, matchClassByLabel, matchClassForSubject } from "./schedule.js";
import { OTHER_SUBJECT, isKnownSubject, normalizeSubjectLabel, subjectFromCourseName } from "./subjects.js";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT = 12000;
const PREVIEW = 80;

function rootDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function notesRoot() {
  return join(rootDir(), "data", "notes");
}

function researchRoot() {
  return join(rootDir(), "data", "research");
}

function ownerDir(root, ownerId) {
  const base = resolve(root);
  const full = resolve(base, ownerId);
  if (full !== join(base, ownerId) && !full.startsWith(base + sep)) {
    throw new Error("Invalid notes owner.");
  }
  return full;
}

function notePath(ownerId, id) {
  return join(ownerDir(notesRoot(), ownerId), `${id}.json`);
}

function eventPath(ownerId, eventId) {
  return join(ownerDir(researchRoot(), ownerId), `${eventId}.json`);
}

async function writeJsonAtomic(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

function titleFromText(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "Untitled note";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

function assertNoteId(raw) {
  const id = String(raw || "").trim();
  if (!ID_RE.test(id)) {
    const err = new Error("Unknown note.");
    err.status = 404;
    throw err;
  }
  return id;
}

async function readJson(filePath) {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function publicNote(note) {
  if (!note) return null;
  return {
    id: note.id,
    title: note.title || "Note",
    text: note.text || "",
    subject: note.subject || "",
    userGoldSubject: note.userGoldSubject || "",
    classId: note.classId || "",
    eventId: note.eventId || "",
    votes: note.votes || {},
    orchestrator: note.orchestrator || {},
    createdAt: note.createdAt || "",
    updatedAt: note.updatedAt || "",
  };
}

function publicNoteRow(note) {
  const full = publicNote(note);
  if (!full) return null;
  const { text, ...row } = full;
  row.textPreview = String(text || "").replace(/\s+/g, " ").trim().slice(0, PREVIEW);
  row.textLength = String(text || "").length;
  return row;
}

function researchEventFromNote(note, { includePreview = true } = {}) {
  const text = String(note.text || "");
  return {
    eventId: note.eventId,
    noteId: note.id,
    createdAt: note.createdAt,
    textLength: text.length,
    textPreview: includePreview ? text.replace(/\s+/g, " ").trim().slice(0, PREVIEW) : "",
    votes: note.votes || {},
    finalSubject: note.subject || "",
    userGoldSubject: note.userGoldSubject || "",
    classId: note.classId || "",
    source: "user",
  };
}

async function saveNote(ownerId, note) {
  await writeJsonAtomic(notePath(ownerId, note.id), note);
}

async function saveEvent(ownerId, event) {
  const stored = { ...event };
  delete stored.text;
  await writeJsonAtomic(eventPath(ownerId, event.eventId), stored);
}

export async function loadNote(ownerId, id) {
  const note = await readJson(notePath(ownerId, assertNoteId(id)));
  if (!note) {
    const err = new Error("Unknown note.");
    err.status = 404;
    throw err;
  }
  return note;
}

export async function listNotes(ownerId) {
  const dir = ownerDir(notesRoot(), ownerId);
  let names = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    const note = await readJson(join(dir, name));
    if (note?.id) rows.push(note);
  }
  rows.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  return rows;
}

export async function listResearchEvents() {
  const root = researchRoot();
  let owners = [];
  try {
    owners = await readdir(root);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const events = [];
  for (const owner of owners) {
    if (owner.startsWith(".")) continue;
    let names = [];
    try {
      names = await readdir(join(root, owner));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const event = await readJson(join(root, owner, name));
      if (!event || typeof event !== "object") continue;
      const { text, ...safe } = event;
      events.push(safe);
    }
  }
  return events;
}

function noteClassRoster(classes) {
  const seen = new Set();
  const out = [];
  for (const c of classes || []) {
    if (c?.freePeriod || isHiddenClassCourse(c)) continue;
    const name = String(c.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: String(c.id || ""),
      name,
      period: String(c.period || ""),
      subject: String(c.subject || subjectFromCourseName(name) || ""),
    });
  }
  return out;
}

async function loadNoteClasses(ownerId, student) {
  const schedule = await loadSchedule(ownerId).catch(() => ({ classes: [] }));
  const fromSchedule = noteClassRoster(schedule.classes);
  if (fromSchedule.length) return fromSchedule;
  if (!student?.canvasToken) return [];
  const courses = await listCourses(student.canvasHost, student.canvasToken).catch(() => []);
  return noteClassRoster(courses);
}

export async function createNote(ownerId, rawText, { req, student } = {}) {
  const text = String(rawText || "").trim();
  if (!text) {
    const err = new Error("Paste some notes first.");
    err.status = 400;
    throw err;
  }
  if (text.length > MAX_TEXT) {
    const err = new Error("Note is too long.");
    err.status = 400;
    throw err;
  }

  const classes = await loadNoteClasses(ownerId, student);
  const classified = await classifyEnsemble(text, { req, student, classes });
  const matched =
    matchClassByLabel(classes, classified.subject) ||
    matchClassForSubject(classes, classified.subject, titleFromText(text));
  const now = new Date().toISOString();
  const note = {
    id: randomUUID(),
    title: titleFromText(text),
    text,
    subject: classified.subject,
    userGoldSubject: "",
    classId: matched?.id || "",
    eventId: randomUUID(),
    votes: classified.votes,
    orchestrator: classified.orchestrator,
    bert: classified.bert,
    createdAt: now,
    updatedAt: now,
  };
  await saveNote(ownerId, note);
  await saveEvent(ownerId, researchEventFromNote(note));
  return note;
}

export async function patchNoteSubject(ownerId, id, subject, { student } = {}) {
  const note = await loadNote(ownerId, id);
  const raw = String(subject || "").trim();
  const roster = await loadNoteClasses(ownerId, student);
  const matched = matchClassByLabel(roster, raw);
  let label = "";
  if (matched) {
    label = matched.name;
    note.classId = matched.id || "";
  } else if (raw.toLowerCase() === "other" || normalizeSubjectLabel(raw) === OTHER_SUBJECT) {
    label = OTHER_SUBJECT;
    note.classId = "";
  } else if (!roster.length) {
    const fallback = normalizeSubjectLabel(raw);
    if (!fallback || !isKnownSubject(fallback)) {
      const err = new Error("Pick one of the eight subjects or Other.");
      err.status = 400;
      throw err;
    }
    label = fallback;
    const schedule = await loadSchedule(ownerId).catch(() => ({ classes: [] }));
    note.classId = matchClassForSubject(schedule.classes, label, note.title)?.id || "";
  } else {
    const err = new Error("Pick one of your classes.");
    err.status = 400;
    throw err;
  }
  note.userGoldSubject = label;
  note.subject = label;
  note.updatedAt = new Date().toISOString();
  await saveNote(ownerId, note);
  const existing = await readJson(eventPath(ownerId, note.eventId));
  const event = existing || researchEventFromNote(note);
  event.userGoldSubject = label;
  event.finalSubject = event.finalSubject || note.subject;
  event.classId = note.classId || "";
  delete event.text;
  await saveEvent(ownerId, event);
  return note;
}

export function mountNotes(app, { requireStudent, fail }) {
  async function ownerFromReq(req, res) {
    const student = await requireStudent(req, res);
    if (!student) return null;
    const ownerId = ownerIdForStudent(student);
    if (!ownerId) {
      res.status(401).json({ error: "Sign in with Google first." });
      return null;
    }
    return { ownerId, student };
  }

  app.post("/v1/me/notes", async (req, res) => {
    try {
      const ctx = await ownerFromReq(req, res);
      if (!ctx) return;
      const note = await createNote(ctx.ownerId, req.body?.text, {
        req,
        student: ctx.student,
      });
      return res.json({ note: publicNote(note) });
    } catch (err) {
      return fail(res, err, err.status || 502);
    }
  });

  app.get("/v1/me/notes", async (req, res) => {
    try {
      const ctx = await ownerFromReq(req, res);
      if (!ctx) return;
      const notes = await listNotes(ctx.ownerId);
      return res.json({ notes: notes.map(publicNoteRow) });
    } catch (err) {
      return fail(res, err);
    }
  });

  app.get("/v1/me/notes/:id", async (req, res) => {
    try {
      const ctx = await ownerFromReq(req, res);
      if (!ctx) return;
      const note = await loadNote(ctx.ownerId, req.params.id);
      return res.json({ note: publicNote(note) });
    } catch (err) {
      return fail(res, err, err.status || 404);
    }
  });

  app.patch("/v1/me/notes/:id", async (req, res) => {
    try {
      const ctx = await ownerFromReq(req, res);
      if (!ctx) return;
      const note = await patchNoteSubject(ctx.ownerId, req.params.id, req.body?.subject, {
        student: ctx.student,
      });
      return res.json({ note: publicNote(note) });
    } catch (err) {
      return fail(res, err, err.status || 400);
    }
  });
}
