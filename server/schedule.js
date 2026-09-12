/**
 * EPS term schedule CARD PDFs (Fall / Winter / Spring printed grid, periods A-H).
 * Not a four11 course-list (`NNNN | Physics`). Students do not upload bells.
 */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ownerIdForStudent } from "./chat-history.js";
import { subjectFromCourseName } from "./subjects.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

const PERIODS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const TERMS = ["fall", "winter", "spring"];
const FREE_NAME = "Free Period";
const MAX_PDF = 12 * 1024 * 1024;

function rootDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function schedulesRoot() {
  return join(rootDir(), "data", "schedules");
}

export function loadBells() {
  return require("./eps-bells-2026.json");
}

function ownerDir(ownerId) {
  const root = resolve(schedulesRoot());
  const full = resolve(root, ownerId);
  if (full !== join(root, ownerId) && !full.startsWith(root + sep)) {
    throw new Error("Invalid schedule owner.");
  }
  return full;
}

function classesPath(ownerId) {
  return join(ownerDir(ownerId), "classes.json");
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
  const extra = `${base}-${term}-${String(period || "").toLowerCase()}`;
  used.add(extra);
  return extra;
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
  return name;
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

export async function loadSchedule(ownerId) {
  try {
    const raw = JSON.parse(await readFile(classesPath(ownerId), "utf8"));
    const classes = Array.isArray(raw?.classes) ? raw.classes : [];
    return {
      classes,
      updated: String(raw.updated || ""),
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { classes: [], updated: "" };
    throw err;
  }
}

export async function saveScheduleFromPdf(ownerId, buffer, filename = "schedule.pdf") {
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
  const parsed = parseScheduleText(text);
  const dir = ownerDir(owner);
  await mkdir(dir, { recursive: true });

  const safeName = String(filename || "schedule.pdf")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "schedule.pdf";
  const pdfName = safeName.toLowerCase().endsWith(".pdf") ? safeName : `${safeName}.pdf`;
  await writeFile(join(dir, pdfName), buffer);

  const payload = {
    classes: parsed.classes,
    updated: new Date().toISOString(),
    pdf: pdfName,
  };
  await writeJsonAtomic(classesPath(owner), payload);
  return payload;
}

export function publicSchedule(stored, bells = loadBells(), now = new Date()) {
  const classes = Array.isArray(stored?.classes) ? stored.classes : [];
  const todayKey = todayKeyFromBells(bells, now);
  return {
    classes,
    bells,
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
      const stored = await saveScheduleFromPdf(ownerId, file.buffer, file.originalname);
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
      return res.json(publicSchedule(stored));
    } catch (err) {
      return fail(res, err);
    }
  });
}
