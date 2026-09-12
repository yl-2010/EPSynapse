/**
 * School pulses. One JSON file per pulse under server/data/pulses/.
 * Ballots store sha256 voter keys only. Results never include keys or names.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getSchool } from "./schools.js";

export const DEFAULT_SCHOOL = "eastside-prep";
export const VOTER_HEADER = "x-epsynapse-voter";

const GRADES = ["9", "10", "11", "12"];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VOTER_RE = /^[A-Za-z0-9._:-]{8,128}$/;

const LPC_QUESTIONS = [
  {
    id: "keep",
    prompt: "Keep the current LPC mains?",
    kind: "single",
    options: [
      { id: "keep", label: "Keep them" },
      { id: "drop", label: "Drop them" },
      { id: "rotate", label: "Rotate weekly" },
    ],
  },
  {
    id: "add",
    prompt: "What should LPC add next?",
    kind: "single",
    options: [
      { id: "protein", label: "More protein" },
      { id: "veg", label: "Better vegetarian" },
      { id: "hot", label: "A hot line that is not pizza" },
      { id: "late", label: "A window after 1pm" },
    ],
  },
  {
    id: "diet",
    prompt: "Dietary gap you hit most?",
    kind: "single",
    options: [
      { id: "none", label: "None" },
      { id: "veg", label: "Vegetarian" },
      { id: "vegan", label: "Vegan" },
      { id: "gluten", label: "Gluten" },
      { id: "kosher", label: "Kosher or halal" },
    ],
  },
  {
    id: "wait",
    prompt: "Peak wait in the line?",
    kind: "single",
    options: [
      { id: "fast", label: "Under 3 min" },
      { id: "ok", label: "3 to 6" },
      { id: "slow", label: "6 to 10" },
      { id: "dead", label: "More than 10" },
    ],
  },
];

// 36 anonymous ballots so the board is not empty. Mix of grades and answers.
const SEED_ROWS = [
  ["keep", "protein", "none", "ok", "9"],
  ["keep", "protein", "none", "ok", "10"],
  ["keep", "protein", "none", "slow", "11"],
  ["keep", "hot", "none", "ok", "12"],
  ["keep", "hot", "none", "slow", "9"],
  ["keep", "veg", "veg", "ok", "10"],
  ["keep", "veg", "none", "fast", "11"],
  ["keep", "late", "none", "ok", "9"],
  ["keep", "protein", "gluten", "slow", "10"],
  ["keep", "hot", "none", "dead", "12"],
  ["keep", "protein", "none", "ok", "10"],
  ["keep", "veg", "veg", "ok", "9"],
  ["keep", "late", "none", "slow", "11"],
  ["keep", "protein", "none", "fast", "10"],
  ["keep", "hot", "vegan", "ok", "11"],
  ["keep", "veg", "none", "ok", "9"],
  ["rotate", "protein", "none", "slow", "10"],
  ["rotate", "hot", "none", "ok", "11"],
  ["rotate", "veg", "veg", "slow", "9"],
  ["rotate", "protein", "none", "ok", "12"],
  ["rotate", "hot", "none", "fast", "10"],
  ["rotate", "late", "none", "slow", "11"],
  ["rotate", "protein", "kosher", "ok", "9"],
  ["rotate", "hot", "none", "dead", "10"],
  ["rotate", "veg", "gluten", "slow", "11"],
  ["rotate", "protein", "none", "ok", "12"],
  ["rotate", "late", "veg", "ok", "10"],
  ["rotate", "hot", "none", "slow", "9"],
  ["rotate", "protein", "none", "fast", ""],
  ["drop", "hot", "none", "dead", "12"],
  ["drop", "late", "none", "slow", "11"],
  ["drop", "protein", "none", "ok", "10"],
  ["drop", "veg", "vegan", "dead", "9"],
  ["drop", "hot", "gluten", "slow", "12"],
  ["drop", "protein", "none", "fast", ""],
  ["rotate", "veg", "kosher", "ok", "10"],
];

let writeChain = Promise.resolve();

export function pulsesDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "data", "pulses");
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertPulseId(raw) {
  const id = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!id || id.length > 80 || id.includes("..") || !ID_RE.test(id)) {
    throw httpError(404, "Pulse not found.");
  }
  return id;
}

function pulsePath(id) {
  const safe = assertPulseId(id);
  const dir = resolve(pulsesDir());
  const full = resolve(dir, `${safe}.json`);
  if (full !== join(dir, `${safe}.json`) && !full.startsWith(dir + sep)) {
    throw httpError(404, "Pulse not found.");
  }
  return full;
}

function publicQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map((q) => ({
    id: String(q.id || ""),
    prompt: String(q.prompt || ""),
    kind: String(q.kind || "single"),
    options: (Array.isArray(q.options) ? q.options : []).map((o) => ({
      id: String(o.id || ""),
      label: String(o.label || ""),
    })),
  }));
}

function hydrate(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const ballots = Array.isArray(src.ballots) ? src.ballots : [];
  return {
    id: String(src.id || ""),
    school: String(src.school || ""),
    topic: String(src.topic || ""),
    title: String(src.title || ""),
    blurb: String(src.blurb || ""),
    status: String(src.status || "open"),
    openedAt: String(src.openedAt || ""),
    updatedAt: String(src.updatedAt || src.openedAt || ""),
    questions: publicQuestions(src.questions),
    grades: Array.isArray(src.grades) && src.grades.length ? src.grades.map(String) : [...GRADES],
    ballots: ballots.map((b) => ({
      voter: String(b?.voter || ""),
      answers: b?.answers && typeof b.answers === "object" ? { ...b.answers } : {},
      grade: String(b?.grade || ""),
      at: String(b?.at || ""),
    })),
  };
}

function seedBallots() {
  const start = Date.parse("2026-09-08T16:20:00Z");
  return SEED_ROWS.map((row, i) => {
    const [keep, add, diet, wait, grade] = row;
    return {
      voter: sha256Hex(`seed-ballot-${i + 1}`),
      answers: { keep, add, diet, wait },
      grade: grade || "",
      at: new Date(start + i * 45 * 60 * 1000).toISOString(),
    };
  });
}

function seedPulseDoc() {
  const ballots = seedBallots();
  const openedAt = "2026-09-08T14:00:00.000Z";
  return {
    id: "lpc-2026-09",
    school: DEFAULT_SCHOOL,
    topic: "LPC",
    title: "This week's LPC",
    blurb: "Four questions. Counts only. No names on the board.",
    status: "open",
    openedAt,
    updatedAt: ballots[ballots.length - 1]?.at || openedAt,
    questions: LPC_QUESTIONS,
    grades: [...GRADES],
    ballots,
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

async function seedEastsidePulse() {
  await mkdir(pulsesDir(), { recursive: true });
  const path = pulsePath("lpc-2026-09");
  try {
    await readFile(path, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    await writeJsonAtomic(path, seedPulseDoc());
  }
}

const seedReady = seedEastsidePulse();

function withWriteLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function readPulseFile(id) {
  await seedReady;
  let path;
  try {
    path = pulsePath(id);
  } catch (err) {
    if (err.status) throw err;
    throw httpError(404, "Pulse not found.");
  }
  try {
    return hydrate(JSON.parse(await readFile(path, "utf8")));
  } catch (err) {
    if (err.code === "ENOENT") throw httpError(404, "Pulse not found.");
    throw err;
  }
}

function optionIds(question) {
  return new Set((question.options || []).map((o) => o.id));
}

function findBallot(pulse, voterKey) {
  if (!voterKey) return null;
  return pulse.ballots.find((b) => b.voter === voterKey) || null;
}

function myAnswersFrom(ballot) {
  if (!ballot) return null;
  const out = { ...ballot.answers };
  if (ballot.grade) out.grade = ballot.grade;
  return out;
}

export function voterKeyFromRequest(req, student) {
  const sub = String(student?.googleSub || "").trim();
  const email = String(student?.email || "").trim();
  if (sub) return sha256Hex(`google:${sub}`);
  if (email) return sha256Hex(`google:${email}`);

  const raw = String(
    (typeof req?.get === "function" && req.get(VOTER_HEADER)) ||
      req?.headers?.[VOTER_HEADER] ||
      ""
  ).trim();
  if (!raw) return "";
  if (!VOTER_RE.test(raw)) {
    throw httpError(400, "Bad X-EPSynapse-Voter header.");
  }
  return sha256Hex(raw);
}

export function requireVoterKey(req, student) {
  const key = voterKeyFromRequest(req, student);
  if (!key) {
    throw httpError(400, "Send a student session or X-EPSynapse-Voter header.");
  }
  return key;
}

export async function schoolCard(slug) {
  const school = await getSchool(slug || DEFAULT_SCHOOL);
  if (!school) {
    return {
      slug: String(slug || DEFAULT_SCHOOL),
      name: "",
      shortName: "",
    };
  }
  return {
    slug: school.slug,
    name: school.name,
    shortName: school.shortName,
  };
}

export function publicPulse(pulse, voterKey) {
  const ballot = findBallot(pulse, voterKey);
  return {
    id: pulse.id,
    topic: pulse.topic,
    title: pulse.title,
    blurb: pulse.blurb,
    status: pulse.status,
    openedAt: pulse.openedAt,
    questions: publicQuestions(pulse.questions),
    grades: [...pulse.grades],
    voted: Boolean(ballot),
    myAnswers: myAnswersFrom(ballot),
  };
}

export async function pulsePayload(pulse, voterKey) {
  return {
    school: await schoolCard(pulse.school),
    pulse: publicPulse(pulse, voterKey),
  };
}

function emptyGradeOptions(pulse) {
  const options = {};
  for (const q of pulse.questions) {
    options[q.id] = Object.fromEntries(q.options.map((o) => [o.id, 0]));
  }
  return options;
}

export function resultsView(pulse) {
  const ballots = pulse.ballots;
  const n = ballots.length;
  const questions = pulse.questions.map((q) => {
    const counts = Object.fromEntries(q.options.map((o) => [o.id, 0]));
    for (const b of ballots) {
      const oid = b.answers?.[q.id];
      if (oid && oid in counts) counts[oid] += 1;
    }
    return {
      id: q.id,
      prompt: q.prompt,
      options: q.options.map((o) => ({
        id: o.id,
        label: o.label,
        count: counts[o.id],
        pct: n ? Math.round((100 * counts[o.id]) / n) : 0,
      })),
    };
  });

  const byGrade = {};
  for (const g of pulse.grades) {
    byGrade[g] = { n: 0, options: emptyGradeOptions(pulse) };
  }
  let skippedGrade = 0;
  for (const b of ballots) {
    const g = String(b.grade || "");
    if (!g || !byGrade[g]) {
      skippedGrade += 1;
      continue;
    }
    byGrade[g].n += 1;
    for (const q of pulse.questions) {
      const oid = b.answers?.[q.id];
      if (oid && byGrade[g].options[q.id] && oid in byGrade[g].options[q.id]) {
        byGrade[g].options[q.id][oid] += 1;
      }
    }
  }

  return {
    id: pulse.id,
    title: pulse.title,
    topic: pulse.topic,
    status: pulse.status,
    n,
    updatedAt: pulse.updatedAt || pulse.openedAt,
    questions,
    byGrade,
    skippedGrade,
  };
}

export async function loadPulse(id) {
  return readPulseFile(id);
}

export async function currentPulse(schoolSlug) {
  await seedReady;
  const slug = String(schoolSlug || DEFAULT_SCHOOL)
    .trim()
    .toLowerCase() || DEFAULT_SCHOOL;
  let names;
  try {
    names = await readdir(pulsesDir());
  } catch (err) {
    if (err.code === "ENOENT") throw httpError(404, "Pulse not found.");
    throw err;
  }

  let best = null;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let pulse;
    try {
      pulse = await readPulseFile(name.slice(0, -5));
    } catch {
      continue;
    }
    if (pulse.school !== slug || pulse.status !== "open") continue;
    if (!best || String(pulse.openedAt) > String(best.openedAt)) best = pulse;
  }
  if (!best) throw httpError(404, "Pulse not found.");
  return best;
}

function normalizeAnswers(pulse, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw httpError(400, "Answers must be an object.");
  }
  const extras = Object.keys(raw).filter((k) => !pulse.questions.some((q) => q.id === k));
  if (extras.length) {
    throw httpError(400, "Unknown question.");
  }
  const answers = {};
  for (const q of pulse.questions) {
    const value = raw[q.id];
    if (typeof value !== "string" || !value.trim()) {
      throw httpError(400, "Answer every question.");
    }
    const oid = value.trim();
    if (!optionIds(q).has(oid)) {
      throw httpError(400, "That option is not on the list.");
    }
    answers[q.id] = oid;
  }
  return answers;
}

function normalizeGrade(raw) {
  if (raw == null || raw === "") return "";
  const grade = String(raw).trim();
  if (!grade) return "";
  if (!GRADES.includes(grade)) {
    throw httpError(400, "Grade must be 9, 10, 11, 12, or skipped.");
  }
  return grade;
}

export async function castVote(id, { answers, grade, comment, voterKey }) {
  if (comment !== undefined) {
    throw httpError(400, "Comments are not accepted.");
  }
  if (!voterKey) {
    throw httpError(400, "Send a student session or X-EPSynapse-Voter header.");
  }

  return withWriteLock(async () => {
    const pulse = await readPulseFile(id);
    if (pulse.status !== "open") {
      throw httpError(400, "This pulse is closed.");
    }
    const existing = findBallot(pulse, voterKey);
    if (existing) {
      const err = httpError(409, "Already voted.");
      err.payload = await pulsePayload(pulse, voterKey);
      err.results = resultsView(pulse);
      throw err;
    }

    const nextAnswers = normalizeAnswers(pulse, answers);
    const nextGrade = normalizeGrade(grade);
    const now = new Date().toISOString();
    pulse.ballots.push({
      voter: voterKey,
      answers: nextAnswers,
      grade: nextGrade,
      at: now,
    });
    pulse.updatedAt = now;
    await writeJsonAtomic(pulsePath(pulse.id), pulse);
    return {
      payload: await pulsePayload(pulse, voterKey),
      results: resultsView(pulse),
    };
  });
}

function csvCell(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function exportResultsCsv(pulse) {
  const results = resultsView(pulse);
  const lines = ["kind,question_id,option_id,grade,count,pct"];
  for (const q of results.questions) {
    for (const o of q.options) {
      lines.push(
        ["option", q.id, o.id, "", o.count, o.pct].map(csvCell).join(",")
      );
    }
  }
  for (const grade of pulse.grades) {
    const bucket = results.byGrade[grade];
    for (const q of pulse.questions) {
      for (const o of q.options) {
        const count = bucket?.options?.[q.id]?.[o.id] || 0;
        lines.push(
          ["grade", q.id, o.id, grade, count, ""].map(csvCell).join(",")
        );
      }
    }
  }
  lines.push(["skipped", "", "", "", results.skippedGrade, ""].map(csvCell).join(","));
  return `${lines.join("\n")}\n`;
}
