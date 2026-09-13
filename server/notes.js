/**
 * Student notes + research events for the EPSynapse notes classifier.
 * Research events never store full note text. Metrics never return raw notes.
 */

import { randomUUID } from "node:crypto";
import { ownerIdForStudent } from "./chat-history.js";
import { isHiddenClassCourse, listCourses } from "./canvas.js";
import { classifyEnsemble } from "./classify.js";
import { loadSchedule, matchClassByLabel, matchClassForSubject } from "./schedule.js";
import { deleteDoc, getDoc, listDocs, listIds, putDoc } from "./store.js";
import { OTHER_SUBJECT, isKnownSubject, normalizeSubjectLabel, subjectFromCourseName } from "./subjects.js";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT = 12000;
const PREVIEW = 80;
const NOTES = "notes";
const RESEARCH = "research";

function assertOwner(ownerId) {
  const id = String(ownerId || "").trim();
  if (!id || id === "." || id === ".." || /[\\/\0]/.test(id)) {
    throw new Error("Invalid notes owner.");
  }
  return id;
}

/** store.js collection for one owner: notes/<ownerId> -> data/notes/<ownerId>/<id>.json */
function notesCollection(ownerId) {
  return `${NOTES}/${assertOwner(ownerId)}`;
}

function researchCollection(ownerId) {
  return `${RESEARCH}/${assertOwner(ownerId)}`;
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
  await putDoc(notesCollection(ownerId), note.id, note);
}

async function saveEvent(ownerId, event) {
  const stored = { ...event };
  delete stored.text;
  const id = String(stored.eventId || "").trim();
  if (!id) return;
  await putDoc(researchCollection(ownerId), id, stored);
}

async function readEvent(ownerId, eventId) {
  const id = String(eventId || "").trim();
  if (!id) return null;
  return getDoc(researchCollection(ownerId), id);
}

export async function loadNote(ownerId, id) {
  const note = await getDoc(notesCollection(ownerId), assertNoteId(id));
  if (!note) {
    const err = new Error("Unknown note.");
    err.status = 404;
    throw err;
  }
  return note;
}

export async function listNotes(ownerId) {
  const collection = notesCollection(ownerId);
  const ids = await listIds(collection);
  const rows = [];
  for (const id of ids) {
    if (!ID_RE.test(id)) continue;
    const note = await getDoc(collection, id);
    if (note?.id) rows.push(note);
  }
  rows.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  return rows;
}

export async function listResearchEvents() {
  const owners = await listIds(RESEARCH);
  const events = [];
  for (const owner of owners) {
    if (owner.startsWith(".")) continue;
    let docs = [];
    try {
      docs = await listDocs(researchCollection(owner));
    } catch {
      continue;
    }
    for (const { data: event } of docs) {
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
  const existing = await readEvent(ownerId, note.eventId);
  const event = existing || researchEventFromNote(note);
  event.userGoldSubject = label;
  event.finalSubject = event.finalSubject || note.subject;
  event.classId = note.classId || "";
  delete event.text;
  await saveEvent(ownerId, event);
  return note;
}

export async function updateNoteText(ownerId, id, rawText) {
  const note = await loadNote(ownerId, id);
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
  note.text = text;
  note.title = titleFromText(text);
  note.updatedAt = new Date().toISOString();
  await saveNote(ownerId, note);
  const existing = await readEvent(ownerId, note.eventId);
  const event = existing || researchEventFromNote(note);
  event.textLength = text.length;
  event.textPreview = text.replace(/\s+/g, " ").trim().slice(0, PREVIEW);
  delete event.text;
  await saveEvent(ownerId, event);
  return note;
}

export async function deleteNote(ownerId, id) {
  const note = await loadNote(ownerId, id);
  await deleteDoc(notesCollection(ownerId), note.id);
  if (note.eventId) {
    await deleteDoc(researchCollection(ownerId), note.eventId).catch(() => {});
  }
  return { ok: true, id: note.id };
}

/**
 * Account deletion: every note and every research event for one owner.
 * Idempotent; an owner with nothing stored returns zeros.
 */
export async function deleteOwnerData(ownerId) {
  const out = { notes: 0, events: 0 };
  const notesCol = notesCollection(ownerId);
  for (const id of await listIds(notesCol)) {
    if (await deleteDoc(notesCol, id).catch(() => false)) out.notes += 1;
  }
  const researchCol = researchCollection(ownerId);
  for (const id of await listIds(researchCol)) {
    if (await deleteDoc(researchCol, id).catch(() => false)) out.events += 1;
  }
  return out;
}

export { publicNote, publicNoteRow };

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
      let note = await loadNote(ctx.ownerId, req.params.id);
      if (req.body?.text != null) {
        note = await updateNoteText(ctx.ownerId, req.params.id, req.body.text);
      }
      if (req.body?.subject != null && String(req.body.subject).trim()) {
        note = await patchNoteSubject(ctx.ownerId, req.params.id, req.body.subject, {
          student: ctx.student,
        });
      }
      return res.json({ note: publicNote(note) });
    } catch (err) {
      return fail(res, err, err.status || 400);
    }
  });

  app.delete("/v1/me/notes/:id", async (req, res) => {
    try {
      const ctx = await ownerFromReq(req, res);
      if (!ctx) return;
      return res.json(await deleteNote(ctx.ownerId, req.params.id));
    } catch (err) {
      return fail(res, err, err.status || 404);
    }
  });
}
