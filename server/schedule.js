/**
 * Student schedules, stored at data/schedules/<ownerId>/classes.json.
 *
 * Two doors:
 * - "eps": the printed EPS term card (Fall / Winter / Spring grid, periods A-H),
 *   read by the hand-written parser below. Bells come from eps-bells-2026.json.
 *   Not a four11 course-list (`NNNN | Physics`). Students do not upload bells.
 * - "other": any school's schedule PDF, read by the student's own model
 *   (schedule-llm.js). Classes carry their printed period plus a `meetings`
 *   array of weekday/start/end when the PDF has times. No EPS bells.
 *
 * classes.json `source` is "eps-card" (default for old files), "llm", or
 * "four11" (written by the four11 path).
 */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteDoc, getDoc, putDoc } from "./store.js";
import { deleteBlob, listBlobs, putBlob } from "./blobs.js";
import { ownerIdForStudent } from "./chat-history.js";
import { prettyCourseName } from "./canvas.js";
import { applyClassAliases, loadWorkspaceMeta } from "./workspace.js";
import { subjectFromCourseName } from "./subjects.js";
import { normalizeDoor } from "./students.js";
import { parseScheduleWithModel } from "./schedule-llm.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const PERIODS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const TERMS = ["fall", "winter", "spring"];
const FREE_NAME = "Free Period";
const MAX_PDF = 12 * 1024 * 1024;
export const SCHEDULE_SOURCES = ["eps-card", "llm", "four11"];
const DEFAULT_SOURCE = "eps-card";
const DEFAULT_TZ = "America/Los_Angeles";

export function normalizeScheduleSource(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return SCHEDULE_SOURCES.includes(s) ? s : DEFAULT_SOURCE;
}

/** Which parser a student's upload goes through. No student means the legacy EPS path. */
export function scheduleDoorFor(student) {
  if (!student) return "eps";
  return normalizeDoor(student.door);
}

export function loadBells() {
  return require("./eps-bells-2026.json");
}

/**
 * Storage goes through store.js / blobs.js so the same code runs on the Mac
 * (files under data/schedules/<owner>/) and on App Engine (Firestore + GCS).
 * Doc: schedules/<owner> / "classes". Blob: schedules/<owner>/<pdfName>.
 */
function ownerKey(ownerId) {
  const owner = String(ownerId || "").trim();
  if (!owner || owner.includes("/") || owner.includes("..") || owner.includes("\\")) {
    throw new Error("Invalid schedule owner.");
  }
  return owner;
}

function scheduleCollection(ownerId) {
  return `schedules/${ownerKey(ownerId)}`;
}

async function writeClassesDoc(ownerId, payload) {
  await putDoc(scheduleCollection(ownerId), "classes", payload);
}

function slugName(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "class";
}

function classIdFor(name, period, term, used) {
  const base = slugName(name);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const ws = `${base}-ws`;
  if (!used.has(ws)) {
    used.add(ws);
    return ws;
  }
  const extra = [base, term, period ? slugName(period) : ""].filter(Boolean).join("-");
  if (!used.has(extra)) {
    used.add(extra);
    return extra;
  }
  let n = 2;
  while (used.has(`${extra}-${n}`)) n += 1;
  used.add(`${extra}-${n}`);
  return `${extra}-${n}`;
}

function looksLikeFour11(text) {
  const lines = String(text || "").split(/\r?\n/);
  const courseLines = lines.filter((l) => /^\s*\d{4}\s*\|\s+\S/.test(l));
  const periodHits = lines.filter((l) => /^\s*[A-Ha-h](?:\s|[.:\-]|$)./.test(l) || /^\s*Period\s+[A-Ha-h]\b/i.test(l));
  return courseLines.length >= 3 && periodHits.length < 2;
}

function detectTerm(chunk) {
  const t = String(chunk || "").toLowerCase();
  if (/\bwinter\b/.test(t)) return "winter";
  if (/\bspring\b/.test(t)) return "spring";
  if (/\bfall\b/.test(t)) return "fall";
  return "";
}

const COURSE_WORDS = new Set([
  "literature",
  "history",
  "science",
  "calculus",
  "physics",
  "biology",
  "algebra",
  "spanish",
  "hall",
  "study",
  "yoga",
  "programming",
  "learning",
  "intelligence",
  "topics",
  "question",
  "american",
  "states",
  "united",
  "design",
  "ground",
  "independent",
  "period",
  "machine",
  "emergent",
  "writing",
  "english",
  "chemistry",
  "economics",
  "computer",
  "data",
  "origins",
  "social",
  "web",
  "advanced",
  "artificial",
  "calculus",
  "up",
  "ap",
  "ab",
  "bc",
  "speaking",
  "speech",
  "public",
  "introduction",
  "intro",
  "mentor",
  "mentors",
  "seminar",
  "research",
  "journalism",
  "debate",
  "rhetoric",
  "communications",
  "communication",
]);

const NAME_GLUE = new Set(["to", "of", "and", "the", "for", "in", "on", "with", "a", "an"]);

function looksLikePersonName(token) {
  const t = String(token || "");
  if (!/^[A-Z][A-Za-z'’\-]{1,14}$/.test(t)) return false;
  return !COURSE_WORDS.has(t.toLowerCase());
}

export function cleanCourseName(raw) {
  let name = String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s|:.\-–—]+/, "")
    .trim();
  name = name.replace(/\s+[A-Z]{2,6}-[A-Z0-9]+\s*$/g, "").trim();
  name = name.replace(/\b(teacher|room|instructor)\b.*$/i, "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  while (parts.length >= 2 && looksLikePersonName(parts[parts.length - 1])) {
    if (NAME_GLUE.has(parts[parts.length - 2].toLowerCase())) break;
    parts.pop();
  }
  name = parts.join(" ").trim();
  if (name.length > 80) name = name.slice(0, 80).trim();
  return prettyCourseName(name);
}

function isJunkName(name) {
  const n = String(name || "").trim();
  if (!n) return true;
  if (/^(period|course|class|name|teacher|room|term|fall|winter|spring)$/i.test(n)) {
    return true;
  }
  if (/^\d{4}\s*\|/.test(n)) return true;
  return n.length < 2;
}

function isClockName(name) {
  return /^\d{1,2}:\d{2}\b/.test(String(name || "").trim());
}

function periodLine(line) {
  const m = String(line || "").match(
    /^(?:period\s*)?([A-H])(?:\s*[-–:.)\]]\s*|[ \t]+)(.*)$/i
  );
  if (!m) return null;
  return { letter: m[1].toUpperCase(), rest: String(m[2] || "").trim() };
}

function parsePeriodMap(block) {
  const map = {};
  const lines = String(block || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const hit = periodLine(line);
    if (!hit) continue;
    const name = cleanCourseName(hit.rest);
    if (isClockName(name) || isClockName(hit.rest)) {
      if (map[hit.letter] == null) map[hit.letter] = "";
      continue;
    }
    if (!name || /^free\b/i.test(name)) {
      if (map[hit.letter] == null) map[hit.letter] = "";
      continue;
    }
    if (isJunkName(name)) continue;
    map[hit.letter] = name;
  }

  if (Object.keys(map).length >= 3) return map;

  for (let i = 0; i < lines.length; i += 1) {
    const lone = lines[i].match(/^(?:period\s*)?([A-H])(?:\s*[-–:.)\]]\s*)?$/i);
    if (!lone) continue;
    const letter = lone[1].toUpperCase();
    if (map[letter] != null) continue;
    const nextRaw = lines[i + 1] || "";
    if (periodLine(nextRaw) || /^(?:period\s*)?[A-H](?:\s*[-–:.)\]]|[ \t]|$)/i.test(nextRaw)) {
      map[letter] = "";
      continue;
    }
    const next = cleanCourseName(nextRaw);
    if (isClockName(next) || (isJunkName(next) && !/^free\b/i.test(next))) {
      map[letter] = "";
      continue;
    }
    map[letter] = /^free\b/i.test(next) ? "" : next;
  }

  return map;
}

function splitTermBlocks(text) {
  const raw = String(text || "");
  const re = /\b(fall|winter|spring)\b/gi;
  const hits = [];
  let m;
  while ((m = re.exec(raw))) {
    hits.push({ term: m[1].toLowerCase(), index: m.index });
  }
  if (!hits.length) return [{ term: "", text: raw }];
  const blocks = [];
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : raw.length;
    blocks.push({ term: hits[i].term, text: raw.slice(start, end) });
  }
  return blocks;
}

export function parseScheduleText(text) {
  const raw = String(text || "");
  if (looksLikeFour11(raw)) {
    const err = new Error(
      "That looks like a four11 course list. Upload the printed term schedule card (periods A-H)."
    );
    err.status = 400;
    throw err;
  }

  const used = new Set();
  const classes = [];
  const blocks = splitTermBlocks(raw);
  let parsedAny = false;

  for (const block of blocks) {
    const map = parsePeriodMap(block.text);
    const found = Object.keys(map).length;
    if (found < 2) continue;
    parsedAny = true;
    const term = block.term || detectTerm(raw) || "fall";
    for (const period of PERIODS) {
      const name = map[period] != null ? String(map[period]).trim() : "";
      const freePeriod = !name;
      const display = freePeriod ? FREE_NAME : name;
      classes.push({
        id: classIdFor(display, period, term, used),
        name: display,
        period,
        term,
        subject: freePeriod ? "" : subjectFromCourseName(display),
        freePeriod,
      });
    }
  }

  if (!parsedAny) {
    const whole = parsePeriodMap(raw);
    if (Object.keys(whole).length >= 2) {
      const term = detectTerm(raw) || "fall";
      for (const period of PERIODS) {
        const name = whole[period] != null ? String(whole[period]).trim() : "";
        const freePeriod = !name;
        const display = freePeriod ? FREE_NAME : name;
        classes.push({
          id: classIdFor(display, period, term, used),
          name: display,
          period,
          term,
          subject: freePeriod ? "" : subjectFromCourseName(display),
          freePeriod,
        });
      }
      parsedAny = true;
    }
  }

  if (!parsedAny || !classes.length) {
    const err = new Error(
      "Could not read periods A-H from that PDF. Use the printed Fall, Winter, or Spring schedule card."
    );
    err.status = 400;
    throw err;
  }

  return { classes };
}

function extractPdfTextWithPdfKit(filePath) {
  const script = [
    "import PDFKit",
    "import Foundation",
    "let path = CommandLine.arguments[1]",
    "guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { fputs(\"no pdf\\n\", stderr); exit(1) }",
    "for i in 0..<doc.pageCount {",
    "  if let page = doc.page(at: i), let s = page.string { print(s); print(\"\\n\") }",
    "}",
  ].join("\n");
  const result = spawnSync("swift", ["-e", script, filePath], {
    encoding: "utf8",
    timeout: 25000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "PDFKit extract failed");
  }
  return String(result.stdout || "");
}

export async function extractPdfText(buffer) {
  const tmp = join(tmpdir(), `eps-sched-${randomBytes(8).toString("hex")}.pdf`);
  await writeFile(tmp, buffer);
  try {
    const kit = extractPdfTextWithPdfKit(tmp);
    if (kit.trim()) return kit;
  } catch {
    /* fall through to pdf-parse */
  } finally {
    await unlink(tmp).catch(() => {});
  }
  const data = await pdfParse(buffer);
  return String(data?.text || "");
}

function zonedParts(date = new Date(), timeZone = "America/Los_Angeles") {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

function weekdayNumber(short) {
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[short] ?? -1;
}

function minutesFromHhmm(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function todayKeyFromBells(bells, now = new Date()) {
  const parts = zonedParts(now, bells.timezone || "America/Los_Angeles");
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function termForDate(bells, todayKey) {
  const trimesters = bells.trimesters || {};
  for (const term of TERMS) {
    const range = trimesters[term];
    if (!range) continue;
    if (todayKey >= range.start && todayKey <= range.end) return term;
  }
  return "";
}

export function meetingsForToday(classes, bells, now = new Date()) {
  const tz = bells.timezone || "America/Los_Angeles";
  const parts = zonedParts(now, tz);
  const todayKey = `${parts.year}-${parts.month}-${parts.day}`;
  const dow = weekdayNumber(parts.weekday);
  const closed = new Set(bells.closedDates || []);
  if (dow < 1 || dow > 5 || closed.has(todayKey)) return [];
  if (bells.schoolStart && todayKey < bells.schoolStart) return [];
  if (bells.schoolEnd && todayKey > bells.schoolEnd) return [];

  const letters = (bells.weekdayPeriods && bells.weekdayPeriods[String(dow)]) || [];
  const slots = Array.isArray(bells.bells) ? bells.bells : [];
  const term = termForDate(bells, todayKey);
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
  const rows = [];

  for (let i = 0; i < letters.length; i += 1) {
    const period = letters[i];
    const slot = slots[i];
    if (!period || !slot) continue;
    const klass =
      (classes || []).find(
        (c) => c.period === period && (!term || c.term === term)
      ) ||
      (classes || []).find((c) => c.period === period);
    const startMin = minutesFromHhmm(slot.start);
    const endMin = minutesFromHhmm(slot.end);
    rows.push({
      period,
      start: slot.start,
      end: slot.end,
      name: klass?.name || FREE_NAME,
      classId: klass?.id || "",
      freePeriod: klass ? Boolean(klass.freePeriod) : true,
      current: startMin >= 0 && nowMin >= startMin && nowMin < endMin,
      term: klass?.term || term,
    });
  }
  return rows;
}

/**
 * Model output (schedule-llm.js) → the classes.json rows the rest of the app reads.
 * Same fields as an EPS card row (id, name, period, term, subject, freePeriod)
 * plus teacher, room, and meetings [{ day, start, end }]. A class with no printed
 * period gets a generated slot key P1, P2, ... so period stays non-empty.
 */
export function classesFromModelSchedule(parsed) {
  const rows = Array.isArray(parsed?.classes) ? parsed.classes : [];
  const term = detectTerm(parsed?.termLabel || "");
  const used = new Set();
  const usedPeriods = new Set(
    rows.map((c) => String(c?.period || "").trim().toUpperCase()).filter(Boolean)
  );
  let slot = 0;
  const classes = [];
  for (const c of rows) {
    const name = prettyCourseName(String(c?.name || "").replace(/\s+/g, " ").trim());
    if (!name) continue;
    let period = String(c?.period || "").trim();
    if (!period) {
      do {
        slot += 1;
        period = `P${slot}`;
      } while (usedPeriods.has(period.toUpperCase()));
      usedPeriods.add(period.toUpperCase());
    }
    const freePeriod = Boolean(c?.freePeriod);
    classes.push({
      id: classIdFor(name, period, term, used),
      name,
      period,
      term,
      subject: freePeriod ? "" : subjectFromCourseName(name),
      freePeriod,
      teacher: String(c?.teacher || "").trim(),
      room: String(c?.room || "").trim(),
      meetings: Array.isArray(c?.meetings) ? c.meetings : [],
    });
  }
  return classes;
}

export async function loadSchedule(ownerId) {
  const raw = await getDoc(scheduleCollection(ownerId), "classes");
  if (!raw) {
    return { classes: [], updated: "", source: "", school: "", termLabel: "", pdf: "" };
  }
  const classes = Array.isArray(raw?.classes) ? raw.classes : [];
  return {
    classes,
    updated: String(raw.updated || ""),
    source: normalizeScheduleSource(raw.source),
    school: String(raw.school || ""),
    termLabel: String(raw.termLabel || ""),
    pdf: String(raw.pdf || ""),
  };
}

/**
 * Parse and store an uploaded schedule PDF.
 * `student` picks the parser: door "eps" (or no student) uses the EPS card
 * parser; door "other" sends the text to the student's model. `req` lets the
 * model path see a Bearer key on the request, same as chat.
 */
export async function saveScheduleFromPdf(
  ownerId,
  buffer,
  filename = "schedule.pdf",
  { student = null, req = null } = {}
) {
  const owner = String(ownerId || "").trim();
  if (!owner) {
    const err = new Error("Sign in first.");
    err.status = 401;
    throw err;
  }
  if (!buffer || !buffer.length) {
    const err = new Error("Upload a PDF.");
    err.status = 400;
    throw err;
  }
  if (buffer.length > MAX_PDF) {
    const err = new Error("PDF is too large.");
    err.status = 400;
    throw err;
  }
  const header = buffer.subarray(0, 5).toString("utf8");
  if (!header.startsWith("%PDF")) {
    const err = new Error("That file is not a PDF.");
    err.status = 400;
    throw err;
  }

  const text = await extractPdfText(buffer);
  const door = scheduleDoorFor(student);
  let classes;
  let source = "eps-card";
  let school = "";
  let termLabel = "";
  if (door === "other") {
    const parsed = await parseScheduleWithModel(text, { student, req });
    classes = classesFromModelSchedule(parsed);
    if (!classes.length) {
      const err = new Error("Could not find any classes in that PDF. Upload a schedule that lists your courses.");
      err.status = 400;
      throw err;
    }
    source = "llm";
    school = parsed.school || "";
    termLabel = parsed.termLabel || "";
  } else {
    classes = parseScheduleText(text).classes;
  }
  const safeName = String(filename || "schedule.pdf")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "schedule.pdf";
  const pdfName = safeName.toLowerCase().endsWith(".pdf") ? safeName : `${safeName}.pdf`;
  await putBlob(`${scheduleCollection(owner)}/${pdfName}`, buffer, {
    contentType: "application/pdf",
  });

  const payload = {
    classes,
    updated: new Date().toISOString(),
    pdf: pdfName,
    source,
    school,
    termLabel,
  };
  await writeClassesDoc(owner, payload);
  return payload;
}

/**
 * Account deletion: the classes doc plus every uploaded PDF under
 * schedules/<owner>/. Idempotent.
 */
export async function deleteOwnerData(ownerId) {
  const collection = scheduleCollection(ownerId);
  const out = { classes: false, pdfs: 0 };
  out.classes = await deleteDoc(collection, "classes").catch(() => false);
  for (const blob of await listBlobs(`${collection}/`)) {
    // In files mode classes.json sits in the same folder; store.js already removed it.
    if (blob.key.endsWith("/classes.json")) continue;
    if (await deleteBlob(blob.key).catch(() => false)) out.pdfs += 1;
  }
  return out;
}

/**
 * Persist a schedule that did not come from a PDF (four11 sync for the EPS door).
 * Same classes.json shape as the upload path, no pdf field.
 */
export async function saveScheduleClasses(ownerId, { classes, source, school = "", termLabel = "" }) {
  const owner = String(ownerId || "").trim();
  if (!owner) throw new Error("Schedule owner is required.");
  if (!Array.isArray(classes) || !classes.length) {
    const err = new Error("No classes to save.");
    err.status = 400;
    throw err;
  }
  const payload = {
    classes,
    updated: new Date().toISOString(),
    pdf: "",
    source: normalizeScheduleSource(source),
    school: String(school || ""),
    termLabel: String(termLabel || ""),
  };
  await writeClassesDoc(owner, payload);
  return payload;
}

/**
 * Today's meetings for a schedule that stores its own times (source "llm").
 * Same row shape as meetingsForToday so the client code paths do not change:
 * { period, start, end, name, classId, freePeriod, current, term, day }.
 * Returns [] on weekends or when no class has a meeting today.
 */
export function todayMeetingsFor(schedule, date = new Date(), timeZone = DEFAULT_TZ) {
  const classes = Array.isArray(schedule?.classes) ? schedule.classes : [];
  const parts = zonedParts(date, timeZone);
  const dow = weekdayNumber(parts.weekday);
  if (dow < 1 || dow > 5) return [];
  const today = parts.weekday;
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
  const rows = [];
  for (const klass of classes) {
    for (const m of Array.isArray(klass?.meetings) ? klass.meetings : []) {
      if (!m || m.day !== today) continue;
      const startMin = minutesFromHhmm(m.start);
      const endMin = minutesFromHhmm(m.end);
      if (startMin < 0 || endMin < 0) continue;
      rows.push({
        period: String(klass.period || ""),
        start: m.start,
        end: m.end,
        name: prettyCourseName(klass.name || "") || FREE_NAME,
        classId: klass.id || "",
        freePeriod: Boolean(klass.freePeriod),
        current: nowMin >= startMin && nowMin < endMin,
        term: klass.term || "",
        day: today,
      });
    }
  }
  rows.sort((a, b) => minutesFromHhmm(a.start) - minutesFromHhmm(b.start));
  return rows;
}

/** True when a schedule stores at least one weekday/time meeting. */
export function scheduleHasMeetings(schedule) {
  return (Array.isArray(schedule?.classes) ? schedule.classes : []).some(
    (c) => Array.isArray(c?.meetings) && c.meetings.length > 0
  );
}

export function publicSchedule(stored, bells = loadBells(), now = new Date()) {
  const source = normalizeScheduleSource(stored?.source);
  const classes = (Array.isArray(stored?.classes) ? stored.classes : []).map((c) => ({
    ...c,
    name: prettyCourseName(c?.name || ""),
  }));
  const common = {
    classes,
    source,
    school: String(stored?.school || ""),
    termLabel: String(stored?.termLabel || ""),
  };

  if (source === "llm") {
    // Not an EPS schedule: EPS bells do not apply. Use stored meetings when the
    // PDF had times, otherwise say so instead of pretending.
    const hasTimes = scheduleHasMeetings(stored);
    const parts = zonedParts(now, DEFAULT_TZ);
    return {
      ...common,
      bells: null,
      noBellTimes: !hasTimes,
      todayKey: `${parts.year}-${parts.month}-${parts.day}`,
      meetings: hasTimes ? todayMeetingsFor({ ...stored, classes }, now) : [],
      term: "",
    };
  }

  const todayKey = todayKeyFromBells(bells, now);
  return {
    ...common,
    bells,
    noBellTimes: false,
    todayKey,
    meetings: meetingsForToday(classes, bells, now),
    term: termForDate(bells, todayKey),
  };
}

export function matchClassForSubject(classes, subject, nameHint = "") {
  const rows = (classes || []).filter((c) => !c.freePeriod);
  const subj = String(subject || "").trim().toLowerCase();
  const hint = String(nameHint || "").trim().toLowerCase();
  if (subj) {
    const bySubject = rows.find(
      (c) =>
        String(c.subject || "").toLowerCase() === subj ||
        String(c.name || "").toLowerCase().includes(subj)
    );
    if (bySubject) return bySubject;
  }
  if (hint) {
    const byName = rows.find((c) => {
      const n = String(c.name || "").toLowerCase();
      return n && (hint.includes(n) || n.includes(hint));
    });
    if (byName) return byName;
  }
  return null;
}

export function matchClassByLabel(classes, label) {
  const rows = (classes || []).filter((c) => !c.freePeriod);
  const key = String(label || "").trim().toLowerCase();
  if (!key) return null;
  const byId = rows.find((c) => String(c.id || "").toLowerCase() === key);
  if (byId) return byId;
  const exact = rows.find((c) => String(c.name || "").trim().toLowerCase() === key);
  if (exact) return exact;
  return rows.find((c) => {
    const n = String(c.name || "").trim().toLowerCase();
    return n && (n.includes(key) || key.includes(n));
  }) || null;
}

export function mountSchedule(app, { requireStudent, fail, upload }) {
  app.post("/v1/me/schedule/pdf", upload.single("pdf"), async (req, res) => {
    try {
      const student = await requireStudent(req, res);
      if (!student) return;
      const ownerId = ownerIdForStudent(student);
      if (!ownerId) {
        return res.status(401).json({ error: "Sign in with Google first." });
      }
      const file = req.file || (Array.isArray(req.files) ? req.files[0] : null);
      if (!file?.buffer) {
        return res.status(400).json({ error: "Attach a PDF as field pdf." });
      }
      const stored = await saveScheduleFromPdf(ownerId, file.buffer, file.originalname, {
        student,
        req,
      });
      return res.json(publicSchedule(stored));
    } catch (err) {
      return fail(res, err, err.status || 400);
    }
  });

  app.get("/v1/me/schedule", async (req, res) => {
    try {
      const student = await requireStudent(req, res);
      if (!student) return;
      const ownerId = ownerIdForStudent(student);
      if (!ownerId) {
        return res.status(401).json({ error: "Sign in with Google first." });
      }
      const stored = await loadSchedule(ownerId);
      const meta = await loadWorkspaceMeta(ownerId).catch(() => ({ classAliases: {} }));
      // No schedule yet: an "other" door student must not be shown EPS bells.
      const source = stored.source || (scheduleDoorFor(student) === "other" ? "llm" : "eps-card");
      return res.json(
        publicSchedule({
          ...stored,
          source,
          classes: applyClassAliases(stored.classes || [], meta.classAliases),
        })
      );
    } catch (err) {
      return fail(res, err);
    }
  });
}
