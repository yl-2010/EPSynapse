/**
 * Eastside Prep schedules from the four11 API.
 *
 * Mirrors epschedule (github.com/guberti/epschedule, cron/four11.py and cron/schedules.py):
 *   GET {base}/epschedule/people                Authorization: Bearer <key>
 *       -> [{ id, firstname, lastname, lunch_id, email, gradyear, photo_url, preferred_name }]
 *       gradyear is "fac/staff" for adults, else the graduating year.
 *   GET {base}/epsnet/courses/{username}?term_id=1|2|3
 *       -> { individual: { id, firstname, lastname, preferred_name, email, gradyear, office,
 *                          birthday, early_dismissal },
 *            sections: [{ period, location, course, teacher, department }] }
 *       period looks like "A" or "A - US"; teacher is a username; term 1..3 = fall, winter, spring.
 *
 * Off when FOUR11_API_KEY is unset. Nothing runs at import time.
 */

import { studentFromRequest } from "./students.js";
import { ownerIdForStudent } from "./chat-history.js";
import { saveScheduleClasses } from "./schedule.js";
import { prettyCourseName } from "./canvas.js";
import { subjectFromCourseName } from "./subjects.js";

const DEFAULT_BASE = "https://four11.eastsideprep.org";
const PEOPLE_PATH = "/epschedule/people";
const COURSES_PATH = "/epsnet/courses/";
const EPS_DOMAIN = "eastsideprep.org";
const ROSTER_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_MS = 20_000;
const MISSING_BIRTHDAY = "03/14";

export const PARSEABLE_PERIODS = ["A", "B", "C", "D", "E", "F", "G", "H", "Advisory"];
export const TERMS = ["fall", "winter", "spring"];
const CLASS_PERIODS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const FREE_NAME = "Free Period";

let rosterCache = { people: [], fetchedAt: 0 };
let rosterInflight = null;

function envStr(name, fallback = "") {
  return String(process.env[name] || "").trim() || fallback;
}

function config() {
  return {
    key: envStr("FOUR11_API_KEY"),
    base: envStr("FOUR11_BASE", DEFAULT_BASE).replace(/\/+$/, ""),
  };
}

export function four11Configured() {
  return Boolean(config().key);
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function four11Get(pathAndQuery) {
  const cfg = config();
  if (!cfg.key) throw httpError("four11 is not set up. FOUR11_API_KEY is missing.", 503);
  let res;
  try {
    res = await fetch(`${cfg.base}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${cfg.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_MS),
    });
  } catch (err) {
    const timedOut = err && err.name === "TimeoutError";
    throw httpError(timedOut ? "four11 timed out." : "Could not reach four11.", 502);
  }
  if (res.status === 401 || res.status === 403) {
    throw httpError("four11 rejected the API key.", 502);
  }
  if (res.status === 404) throw httpError("four11 has no record for that account.", 404);
  if (!res.ok) throw httpError(`four11 returned ${res.status}.`, 502);
  return res.json();
}

export function usernameFromEmail(email) {
  return String(email || "").trim().toLowerCase().split("@")[0];
}

function isStaff(gradyear) {
  return String(gradyear || "").toLowerCase() === "fac/staff";
}

/** Same fields epschedule's Four11User keeps, plus derived username / displayName. */
function normalizePerson(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const email = String(src.email || "").trim();
  const firstname = String(src.firstname || "").trim();
  const lastname = String(src.lastname || "").trim();
  const preferred = src.preferred_name ? String(src.preferred_name).trim() : "";
  const gradyear = src.gradyear === null || src.gradyear === undefined ? "" : src.gradyear;
  const staff = isStaff(gradyear);
  const year = Number(gradyear);
  return {
    id: src.id ?? null,
    firstname,
    lastname,
    lunch_id: src.lunch_id ?? null,
    email,
    gradyear,
    photo_url: String(src.photo_url || ""),
    preferred_name: preferred || null,
    username: usernameFromEmail(email),
    displayName: `${preferred || firstname} ${lastname}`.trim(),
    isStaff: staff,
    classOf: !staff && Number.isFinite(year) && year > 0 ? year : null,
  };
}

/** Roster, cached six hours. Pass { force: true } to refetch. */
export async function four11People({ force = false } = {}) {
  const fresh = rosterCache.people.length && Date.now() - rosterCache.fetchedAt < ROSTER_TTL_MS;
  if (fresh && !force) return rosterCache.people;
  if (rosterInflight) return rosterInflight;
  rosterInflight = (async () => {
    try {
      const rows = await four11Get(PEOPLE_PATH);
      const people = (Array.isArray(rows) ? rows : []).map(normalizePerson).filter((p) => p.email);
      rosterCache = { people, fetchedAt: Date.now() };
      return people;
    } finally {
      rosterInflight = null;
    }
  })();
  return rosterInflight;
}

function cachedRoster() {
  return rosterCache.people;
}

/** Case-insensitive match on the roster email, or on username@eastsideprep.org. */
export async function four11PersonByEmail(email) {
  const needle = String(email || "").trim().toLowerCase();
  if (!needle) return null;
  const username = usernameFromEmail(needle);
  const alt = `${username}@${EPS_DOMAIN}`;
  const people = await four11People();
  return (
    people.find((p) => p.email.toLowerCase() === needle) ||
    people.find((p) => p.email.toLowerCase() === alt) ||
    null
  );
}

/** One term. termId 1..3. Returns the raw four11 object { individual, sections }. */
export async function four11CoursesForTerm(personKey, termId) {
  const key = encodeURIComponent(String(personKey || "").trim());
  if (!key) throw httpError("four11 username is required.", 400);
  const term = Number(termId);
  if (![1, 2, 3].includes(term)) throw httpError("term_id must be 1, 2, or 3.", 400);
  return four11Get(`${COURSES_PATH}${key}?term_id=${term}`);
}

/**
 * All three terms for one person. epschedule passes the username (email local part) as
 * the path id, so pass person.username. Returns [fallRaw, winterRaw, springRaw].
 */
export async function four11Courses(personKey) {
  const out = [];
  for (const termId of [1, 2, 3]) {
    out.push(await four11CoursesForTerm(personKey, termId));
  }
  return out;
}

function teacherNameFor(username, roster) {
  const u = String(username || "").trim().toLowerCase();
  if (!u) return "";
  const hit = (roster || []).find((p) => p.username === u);
  return hit ? hit.displayName : "";
}

function freePeriodEntry(period) {
  return {
    period,
    name: FREE_NAME,
    room: null,
    teacher: null,
    teacherUsername: null,
    department: null,
  };
}

/** epschedule add_free_periods_to_schedule: one entry per period, free when missing. */
function addFreePeriods(list) {
  for (const period of PARSEABLE_PERIODS) {
    if (!list.some((c) => c.period === period)) list.push(freePeriodEntry(period));
  }
  return list;
}

function periodSortKey(period) {
  return period === "Advisory" ? "Z" : period;
}

/** epschedule decode_trimester_classes plus the one-per-period filter from crawl_schedules. */
export function decodeTermClasses(raw, roster = cachedRoster()) {
  const sections = Array.isArray(raw?.sections) ? raw.sections : [];
  const list = [];
  for (const sec of sections) {
    // Drop the " - US" style suffix.
    const period = String(sec?.period || "").trim().split(" ")[0];
    if (!PARSEABLE_PERIODS.includes(period)) continue;
    const teacherUsername = sec?.teacher ? String(sec.teacher).trim() : null;
    list.push({
      period,
      name: String(sec?.course || "").trim(),
      room: sec?.location ? String(sec.location).trim() : null,
      teacher: teacherNameFor(teacherUsername, roster) || null,
      teacherUsername,
      department: sec?.department ? String(sec.department).trim() : null,
    });
  }
  addFreePeriods(list);
  list.sort((a, b) => periodSortKey(a.period).localeCompare(periodSortKey(b.period)));
  // One row per period, first match wins.
  return PARSEABLE_PERIODS.map((period) => list.find((c) => c.period === period)).filter(Boolean);
}

/** epschedule get_current_school_year: the year the current school year ends in. */
export function currentSchoolYear(now = new Date()) {
  let end = now.getFullYear();
  const month = now.getMonth() + 1;
  if (month >= 7 || (month >= 6 && now.getDate() >= 10)) end += 1;
  return end;
}

/**
 * person: roster entry from four11PersonByEmail. courses: output of four11Courses
 * (array of raw term objects; a single raw object is treated as fall only).
 * Returns { terms: { fall, winter, spring }, advisor, individual, grade }.
 */
export function buildEpsSchedule(person, courses, roster = cachedRoster()) {
  const raws = Array.isArray(courses) ? courses : courses ? [courses] : [];
  const terms = { fall: [], winter: [], spring: [] };
  raws.forEach((raw, i) => {
    const term = TERMS[i];
    if (term) terms[term] = decodeTermClasses(raw, roster);
  });

  const last = raws.length ? raws[raws.length - 1] : null;
  const ind = last?.individual && typeof last.individual === "object" ? last.individual : {};
  let advisor = null;
  for (const sec of Array.isArray(last?.sections) ? last.sections : []) {
    if (/advisory/i.test(String(sec?.course || ""))) advisor = String(sec.teacher || "") || null;
  }

  const gradyearRaw = ind.gradyear ?? person?.gradyear ?? "";
  const gradyear = Number(gradyearRaw);
  const student = Number.isFinite(gradyear) && gradyear > 0 && !isStaff(gradyearRaw);
  const grade = student ? 12 - (gradyear - currentSchoolYear()) : null;
  const birthday = ind.birthday && ind.birthday !== MISSING_BIRTHDAY ? String(ind.birthday) : "";
  const office = ind.office && ind.office !== "No-loc" ? String(ind.office) : "";

  return {
    terms,
    advisor,
    advisorName: teacherNameFor(advisor, roster) || "",
    individual: {
      sid: ind.id ?? person?.id ?? null,
      firstname: String(ind.firstname || person?.firstname || ""),
      lastname: String(ind.lastname || person?.lastname || ""),
      preferredName: String(ind.preferred_name || person?.preferred_name || ""),
      username: usernameFromEmail(ind.email || person?.email || ""),
      gradyear: student ? gradyear : gradyearRaw || null,
      grade,
      office,
      birthday,
      earlyDismissal: Boolean(ind.early_dismissal),
    },
  };
}

function slugName(name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "class";
}

/** Same id scheme as schedule.js classIdFor so existing classes / todos keep matching. */
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

/**
 * Convert buildEpsSchedule() output into the classes.json payload schedule.js writes
 * from a PDF: { classes: [{ id, name, period, term, subject, freePeriod }], updated }.
 * Periods A-H only; Advisory has no bell slot. room / teacher ride along as extras.
 * Does not write to disk.
 */
export function toEpsynapseClasses(schedule) {
  const terms = schedule?.terms && typeof schedule.terms === "object" ? schedule.terms : {};
  const used = new Set();
  const classes = [];
  for (const term of TERMS) {
    const rows = Array.isArray(terms[term]) ? terms[term] : [];
    if (!rows.length) continue;
    for (const period of CLASS_PERIODS) {
      const row = rows.find((c) => c.period === period);
      const rawName = row && row.name && row.name !== FREE_NAME ? row.name : "";
      const freePeriod = !rawName;
      const display = freePeriod ? FREE_NAME : prettyCourseName(rawName) || rawName;
      const entry = {
        id: classIdFor(display, period, term, used),
        name: display,
        period,
        term,
        subject: freePeriod ? "" : subjectFromCourseName(display),
        freePeriod,
      };
      if (!freePeriod) {
        if (row.room) entry.room = row.room;
        if (row.teacher) entry.teacher = row.teacher;
        if (row.teacherUsername) entry.teacherUsername = row.teacherUsername;
        if (row.department) entry.department = row.department;
      }
      classes.push(entry);
    }
  }
  return { classes, updated: new Date().toISOString(), source: "four11" };
}

function fail(res, err, fallback = 500) {
  const status = Number(err?.status) || fallback;
  const safe = status >= 400 && status < 600 ? status : fallback;
  return res.status(safe).json({ error: String(err?.message || "Request failed.") });
}

/** Emails to try against the roster, Microsoft sign-in first. */
export function rosterEmailCandidates(student) {
  const out = [];
  const add = (v) => {
    const s = String(v || "").trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  };
  add(student?.msServices?.email);
  add(student?.graph?.email);
  add(student?.outlook?.email);
  add(student?.teams?.email);
  add(student?.email);
  return out;
}

export async function four11PersonForStudent(student) {
  for (const email of rosterEmailCandidates(student)) {
    const person = await four11PersonByEmail(email);
    if (person) return person;
  }
  return null;
}

export function mountFour11(app) {
  /**
   * Fetch the signed-in EPS student's four11 schedule and return it in both the raw
   * term shape and the classes.json shape. Nothing is persisted here. index.js should
   * write `classes` with the same code path saveScheduleFromPdf uses.
   */
  app.post("/v1/me/schedule/four11/sync", async (req, res) => {
    try {
      if (!four11Configured()) {
        return res.status(503).json({
          error: "four11 is not set up yet. The school API key is missing.",
          configured: false,
        });
      }
      const student = await studentFromRequest(req);
      if (!student) return res.status(401).json({ error: "Sign in with Google first." });
      if (student.door !== "eps") {
        return res.status(403).json({
          error: "four11 schedules are for Eastside Prep accounts. Upload your schedule PDF instead.",
        });
      }
      const person = await four11PersonForStudent(student);
      if (!person) {
        return res.status(404).json({
          error: "That email is not on the Eastside Prep roster. Sign in with your @eastsideprep.org account.",
        });
      }
      const courses = await four11Courses(person.username);
      const roster = await four11People();
      const schedule = buildEpsSchedule(person, courses, roster);
      const classes = toEpsynapseClasses(schedule);
      const ownerId = ownerIdForStudent(student);
      if (ownerId && classes.classes?.length) {
        await saveScheduleClasses(ownerId, {
          classes: classes.classes,
          source: "four11",
          school: "Eastside Prep",
          termLabel: `${currentSchoolYear() - 1}-${String(currentSchoolYear()).slice(2)}`,
        });
      }
      return res.json({
        person: {
          name: person.displayName,
          username: person.username,
          gradyear: schedule.individual.gradyear,
          grade: schedule.individual.grade,
        },
        schedule,
        classes,
      });
    } catch (err) {
      return fail(res, err);
    }
  });
}
