/**
 * Generic schedule parser for the "other" door.
 * Any school's schedule PDF, read by the student's own model (Groq, Gemini,
 * OpenRouter). Reuses classify.js's completion helper so provider code lives in
 * one place. EPS term cards still go through the hand-written parser in
 * schedule.js.
 */

import { completeJson, extractJsonObject, studentModelKeys } from "./classify.js";

const MAX_TEXT = 20_000;
const MAX_CLASSES = 40;
const MAX_MEETINGS = 20;
const MAX_NAME = 120;
const MAX_FIELD = 60;
const MAX_LABEL = 80;

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
export const NO_KEY_MESSAGE = "Add a model API key in Settings first.";

const DAY_ALIASES = {
  mon: "Mon",
  monday: "Mon",
  m: "Mon",
  tue: "Tue",
  tues: "Tue",
  tuesday: "Tue",
  t: "Tue",
  wed: "Wed",
  weds: "Wed",
  wednesday: "Wed",
  w: "Wed",
  thu: "Thu",
  thur: "Thu",
  thurs: "Thu",
  thursday: "Thu",
  th: "Thu",
  r: "Thu",
  fri: "Fri",
  friday: "Fri",
  f: "Fri",
};

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function str(value, max) {
  if (value == null) return "";
  const s = String(typeof value === "object" ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

export function normalizeDay(raw) {
  const key = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return DAY_ALIASES[key] || "";
}

/** "8:30", "08:30", "8:30 am", "1:15PM", "13:15" → "HH:MM" (24h) or "". */
export function normalizeTime(raw) {
  const m = String(raw || "")
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return "";
  let hour = Number(m[1]);
  const minute = m[2] == null ? 0 : Number(m[2]);
  const ampm = (m[3] || "").toLowerCase().replace(/\./g, "");
  if (!Number.isInteger(hour) || minute < 0 || minute > 59) return "";
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (!ampm && m[2] == null) return "";
  if (hour < 0 || hour > 23) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function minutes(hhmm) {
  const m = String(hhmm || "").match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

function normalizeMeeting(raw) {
  if (!raw || typeof raw !== "object") return null;
  const day = normalizeDay(raw.day ?? raw.weekday);
  if (!day) return null;
  const start = normalizeTime(raw.start ?? raw.from ?? raw.begin);
  const end = normalizeTime(raw.end ?? raw.to ?? raw.finish);
  if (!start || !end) return null;
  if (minutes(end) <= minutes(start)) return null;
  return { day, start, end };
}

function normalizeMeetings(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const meeting = normalizeMeeting(item);
    if (!meeting) continue;
    const key = `${meeting.day}|${meeting.start}|${meeting.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(meeting);
    if (out.length >= MAX_MEETINGS) break;
  }
  return out;
}

function isJunkClassName(name) {
  const n = String(name || "").trim();
  if (n.length < 2) return true;
  if (/^(period|course|class|name|teacher|room|term|time|day|days|schedule|student|grade|total|n\/?a|none|null|undefined|-+)$/i.test(n)) {
    return true;
  }
  if (/^\d{1,2}:\d{2}/.test(n)) return true;
  if (!/[a-z]/i.test(n)) return true;
  return false;
}

function isFreeName(name) {
  return /^(free|free period|open|study hall|lunch|break|advisory|homeroom|recess)$/i.test(String(name || "").trim());
}

/**
 * Turn whatever the model returned into the strict schema. Never throws on
 * shape problems; drops what it cannot use. Returns null when there is no
 * object at all.
 */
export function normalizeModelSchedule(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    const text = raw.replace(/```(?:json|JSON)?/g, "").trim();
    obj = extractJsonObject(text);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

  const classesRaw = Array.isArray(obj.classes)
    ? obj.classes
    : Array.isArray(obj.courses)
      ? obj.courses
      : [];
  const seen = new Set();
  const classes = [];
  for (const item of classesRaw) {
    if (!item || typeof item !== "object") continue;
    const name = str(item.name ?? item.course ?? item.title, MAX_NAME);
    if (isJunkClassName(name)) continue;
    const period = str(item.period ?? item.block ?? item.slot, 12);
    const key = `${name.toLowerCase()}|${period.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    classes.push({
      name,
      teacher: str(item.teacher ?? item.instructor, MAX_FIELD),
      room: str(item.room ?? item.location, MAX_FIELD),
      period,
      meetings: normalizeMeetings(item.meetings ?? item.times),
      freePeriod: isFreeName(name),
    });
    if (classes.length >= MAX_CLASSES) break;
  }

  return {
    school: str(obj.school, MAX_LABEL),
    termLabel: str(obj.termLabel ?? obj.term, MAX_LABEL),
    classes,
  };
}

const SYSTEM_PROMPT = [
  "You read a student's class schedule from the text of a PDF and return JSON.",
  "Return exactly one JSON object and nothing else: no markdown, no code fences, no commentary.",
  "Schema:",
  '{"school": string, "termLabel": string, "classes": [{"name": string, "teacher": string, "room": string, "period": string, "meetings": [{"day": "Mon"|"Tue"|"Wed"|"Thu"|"Fri", "start": "HH:MM", "end": "HH:MM"}]}]}',
  "Rules:",
  "Keep course names exactly as printed (fix only obvious line-wrap breaks). Do not rename, translate, or expand them.",
  "Do not invent classes, teachers, rooms, or times. Use \"\" for unknown strings and [] for unknown meetings.",
  "Times are 24-hour HH:MM. Only list a meeting when the PDF gives a weekday and a start and end time for that class.",
  "period is the period, block, or slot label as printed (for example \"1\", \"A\", \"Block 3\"). Use \"\" when there is none.",
  "school is the school name if printed, else \"\". termLabel is the term or semester label as printed, else \"\".",
  "Skip headers, footers, student name, ID numbers, and legends. Include lunch, advisory, or study hall only if they appear as scheduled blocks.",
  "One entry per distinct class. If the same class meets several times, put all its meetings in one entry.",
  'If the text is not a class schedule, return {"school": "", "termLabel": "", "classes": []}.',
].join("\n");

function clipText(text) {
  const clean = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) : clean;
}

/**
 * Ask the student's model to read a schedule PDF's text.
 * Throws 402 when the student has no usable model key, 400 when the text has
 * no schedule, 502 when the model host fails.
 */
export async function parseScheduleWithModel(pdfText, { student, req } = {}) {
  const text = clipText(pdfText);
  if (text.length < 20) {
    throw httpError("That PDF has no readable text. Export the schedule as a text PDF, not a scan.", 400);
  }

  const { keys } = studentModelKeys(req, student);
  if (!keys.length) throw httpError(NO_KEY_MESSAGE, 402);

  let result;
  try {
    result = await completeJson(req, student, SYSTEM_PROMPT, `Schedule PDF text:\n\n${text}`);
  } catch (err) {
    if (err?.status === 401) throw httpError(NO_KEY_MESSAGE, 402);
    throw httpError(err?.message || "The model could not read that PDF.", err?.status || 502);
  }

  const parsed = normalizeModelSchedule(result?.content || "");
  if (!parsed) {
    throw httpError("The model did not return a schedule. Try again or use a clearer PDF.", 400);
  }
  if (!parsed.classes.length) {
    throw httpError("Could not find any classes in that PDF. Upload a schedule that lists your courses.", 400);
  }
  return { ...parsed, model: result.model || "", latencyMs: result.latencyMs || 0 };
}
