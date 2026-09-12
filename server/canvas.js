/**
 * Read-only Canvas LMS client. Student access token. No writes.
 */

export const DEFAULT_HOST = "https://eastsideprep.instructure.com";

const PAGE_CAP = 3;
const ASSIGN_CAP = 80;
const FETCH_MS = 15_000;

export function normalizeHost(raw) {
  const s = String(raw || "").trim();
  if (!s) return DEFAULT_HOST;
  let url;
  try {
    url = new URL(s.includes("://") ? s : `https://${s}`);
  } catch {
    throw new Error("Canvas URL must be a valid https host.");
  }
  if (url.protocol !== "https:") {
    throw new Error("Canvas URL must be https.");
  }
  return `${url.protocol}//${url.host}`;
}

export function inferTag(assignment) {
  const name = String(assignment?.name || assignment?.title || "");
  const prefix = name.match(/^\s*(CW|HW|QA|MA)\s*[:\-\u2013]\s*/i);
  if (prefix) return prefix[1].toUpperCase();

  const types = []
    .concat(assignment?.submission_types || [])
    .concat(assignment?.plannable_type || "")
    .map((t) => String(t).toLowerCase());
  const blob = `${name} ${types.join(" ")}`.toLowerCase();

  if (
    types.includes("online_quiz") ||
    /\b(qa|quiz|check[\s-]?in|checkin)\b/.test(blob)
  ) {
    return "QA";
  }
  if (/\b(cw|classwork|in[\s-]?class|do[\s-]?now|warmup|warm[\s-]?up)\b/.test(blob)) {
    return "CW";
  }
  if (
    /\b(exam|test|midterm|final|paper|project|essay|\bma\b)\b/.test(blob)
  ) {
    return "MA";
  }
  return "HW";
}

function linkHeaderNext(link) {
  const raw = String(link || "");
  const parts = raw.split(",");
  for (const part of parts) {
    if (!/rel="next"/i.test(part)) continue;
    const m = part.match(/<([^>]+)>/);
    if (m) return m[1];
  }
  return "";
}

export async function canvasFetch(host, token, pathAndQuery, pageCap = PAGE_CAP) {
  const base = normalizeHost(host);
  const tokenStr = String(token || "").trim();
  if (!tokenStr) {
    const err = new Error("Canvas rejected that token.");
    err.status = 401;
    throw err;
  }

  const first = String(pathAndQuery || "");
  let url = first.startsWith("http")
    ? first
    : `${base}/api/v1${first.startsWith("/") ? first : `/${first}`}`;

  const out = [];
  const pages = Number.isFinite(pageCap) && pageCap > 0 ? pageCap : PAGE_CAP;
  for (let page = 0; page < pages && url; page += 1) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${tokenStr}`, Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_MS),
      });
    } catch (err) {
      const timedOut = err && err.name === "TimeoutError";
      const e = new Error(timedOut ? "Canvas timed out." : "Could not reach Canvas.");
      e.status = 502;
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error("Canvas rejected that token.");
      err.status = 401;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Canvas returned ${res.status}.`);
      err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
      throw err;
    }
    const body = await res.json();
    if (Array.isArray(body)) out.push(...body);
    else return body;
    url = linkHeaderNext(res.headers.get("link"));
  }
  return out;
}

export async function validateToken(host, token) {
  const self = await canvasFetch(host, token, "/users/self");
  return {
    ok: true,
    displayName: String(self.short_name || self.name || "").trim(),
    canvasUserId: String(self.id || ""),
    email: String(self.primary_email || self.email || "").trim(),
    sisUserId: String(self.sis_user_id || "").trim(),
  };
}

function periodFromCode(code) {
  const s = String(code || "").trim();
  // EPS periods are A-H. Trailing digits are course levels (Spanish 4).
  const m = s.match(/(?:^|[\s\-])([A-H])$/i);
  return m ? m[1].toUpperCase() : "";
}

export function normalizeCourseName(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(fall|winter|spring|year)\b/g, " ")
    .replace(/\d{4}-\d{2}\S*/g, " ")
    .replace(/:[a-z][a-z0-9_-]*$/i, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function periodLetter(period) {
  const p = String(period || "").trim().toUpperCase();
  return /^[A-H]$/.test(p) ? p : "";
}

export function isLetterGrade(raw) {
  return /^[ABCDF][+-]?$/i.test(String(raw || "").trim());
}

function courseBlob(course) {
  return normalizeCourseName(`${course?.name || ""} ${course?.courseCode || ""}`);
}

/** Library / peer mentors / advisory / class-of shells are not graded classes. */
export function isNonGradeCourse(course) {
  const n = courseBlob(course);
  if (!n) return false;
  if (/\bpeer\s*mentor(s|ing)?\b/.test(n)) return true;
  if (/\b(eps\s+)?library\b/.test(n)) return true;
  if (/\b(advisor|advisory)\b/.test(n)) return true;
  if (/\bclass of \d{4}\b/.test(n)) return true;
  return false;
}

/** Hide library / advisory / class-of from the class list. Keep peer mentors. */
export function isHiddenClassCourse(course) {
  const n = courseBlob(course);
  if (!n) return false;
  if (/\b(eps\s+)?library\b/.test(n)) return true;
  if (/\b(advisor|advisory)\b/.test(n)) return true;
  if (/\bclass of \d{4}\b/.test(n)) return true;
  return false;
}

export function courseNamesMatch(className, courseName) {
  const dash = normalizeCourseName(className);
  const canvas = normalizeCourseName(courseName);
  if (!dash || !canvas) return false;
  if (dash === canvas) return true;
  if (!canvas.includes(dash) && !dash.includes(canvas)) return false;
  const numA = dash.match(/\b(\d+)\s*$/);
  const numB = canvas.match(/\b(\d+)\s*$/);
  if (numA || numB) return Boolean(numA && numB && numA[1] === numB[1]);
  return true;
}

export function applyScheduleToGrades(grades, classes) {
  const rows = (grades || []).filter((c) => !isNonGradeCourse(c));
  const scheduled = (classes || []).filter((c) => !c.freePeriod && !isNonGradeCourse(c));
  return rows.map((g) => {
    const match = scheduled.find(
      (c) =>
        (g.id && (c.canvasCourseId === g.id || c.courseId === g.id || c.id === g.id)) ||
        courseNamesMatch(c.name, g.name)
    );
    return {
      ...g,
      currentGrade: isLetterGrade(g.currentGrade) ? g.currentGrade : "",
      period: periodLetter(match?.period || g.period),
    };
  });
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") {
    const cleaned = v.replace(/%/g, "").replace(/,/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickNum(...vals) {
  const nums = vals.map(numOrNull).filter((n) => n != null);
  if (!nums.length) return null;
  const nonzero = nums.find((n) => n !== 0);
  return nonzero != null ? nonzero : 0;
}

function pickLetter(...vals) {
  for (const v of vals) {
    const s = String(v || "").trim();
    if (isLetterGrade(s)) return s;
  }
  return "";
}

function letterFromPercent(score) {
  const n = numOrNull(score);
  if (n == null) return "";
  if (n >= 93) return "A";
  if (n >= 90) return "A-";
  if (n >= 87) return "B+";
  if (n >= 83) return "B";
  if (n >= 80) return "B-";
  if (n >= 77) return "C+";
  if (n >= 73) return "C";
  if (n >= 70) return "C-";
  if (n >= 67) return "D+";
  if (n >= 63) return "D";
  if (n >= 60) return "D-";
  return "F";
}

function preferScore(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  if (a === 0 && b !== 0) return b;
  if (b === 0 && a !== 0) return a;
  return a;
}

function studentEnrollment(course) {
  const rows = Array.isArray(course?.enrollments) ? course.enrollments : [];
  return (
    rows.find((e) => /student/i.test(String(e.type || e.role || ""))) ||
    rows[0] ||
    null
  );
}

function scoresFromEnrollment(enr) {
  if (!enr) {
    return {
      currentScore: null,
      currentGrade: "",
      finalScore: null,
      finalGrade: "",
      htmlUrl: "",
    };
  }
  const g = enr.grades || {};
  // Current / unposted current only. Final treats missing work as 0 and
  // is not what Canvas shows the student as their grade.
  const currentScore = pickNum(
    g.current_score,
    enr.computed_current_score,
    g.unposted_current_score,
    enr.computed_unposted_current_score,
    enr.current_period_computed_current_score,
    enr.current_period_computed_unposted_current_score
  );
  const currentGrade = pickLetter(
    g.current_grade,
    enr.computed_current_grade,
    enr.computed_current_letter_grade,
    g.unposted_current_grade,
    enr.computed_unposted_current_grade,
    enr.current_period_computed_current_grade,
    letterFromPercent(currentScore)
  );
  return {
    currentScore,
    currentGrade,
    finalScore: pickNum(g.final_score, enr.computed_final_score),
    finalGrade: pickLetter(g.final_grade, enr.computed_final_grade),
    htmlUrl: String(g.html_url || enr.html_url || "").trim(),
  };
}

function mapCourse(c) {
  const scored = scoresFromEnrollment(studentEnrollment(c));
  return {
    id: String(c.id),
    name: String(c.name || c.course_code || "Class").trim(),
    courseCode: String(c.course_code || "").trim(),
    period: periodFromCode(c.course_code),
    currentScore: scored.currentScore,
    currentGrade: scored.currentGrade,
    finalScore: scored.finalScore,
    finalGrade: scored.finalGrade,
    htmlUrl: scored.htmlUrl || String(c.html_url || "").trim(),
  };
}

function mergeScores(course, enr) {
  const scored = scoresFromEnrollment(enr);
  const currentScore = preferScore(course.currentScore, scored.currentScore);
  return {
    ...course,
    currentScore,
    currentGrade:
      course.currentGrade ||
      scored.currentGrade ||
      letterFromPercent(currentScore),
    finalScore: preferScore(course.finalScore, scored.finalScore),
    finalGrade: course.finalGrade || scored.finalGrade,
    htmlUrl: course.htmlUrl || scored.htmlUrl,
  };
}

async function attachEnrollmentGrades(host, token, courses) {
  let enrollments;
  try {
    enrollments = await canvasFetch(
      host,
      token,
      "/users/self/enrollments?type[]=StudentEnrollment&state[]=active&per_page=100"
    );
  } catch {
    enrollments = [];
  }
  if (!Array.isArray(enrollments) || !enrollments.length) {
    try {
      enrollments = await canvasFetch(
        host,
        token,
        "/users/self/enrollments?state[]=active&per_page=100"
      );
    } catch {
      return courses;
    }
  }
  if (!Array.isArray(enrollments)) return courses;
  const byCourse = new Map();
  for (const e of enrollments) {
    if (!e?.course_id) continue;
    if (e.type && !/student/i.test(String(e.type)) && !/student/i.test(String(e.role || ""))) {
      continue;
    }
    const id = String(e.course_id);
    const prev = byCourse.get(id);
    if (!prev) {
      byCourse.set(id, e);
      continue;
    }
    const next = scoresFromEnrollment(e);
    const old = scoresFromEnrollment(prev);
    if (preferScore(old.currentScore, next.currentScore) === next.currentScore &&
        next.currentScore !== old.currentScore) {
      byCourse.set(id, e);
    }
  }
  return courses.map((c) => mergeScores(c, byCourse.get(String(c.id))));
}

export async function listCourses(host, token) {
  let rows;
  try {
    rows = await canvasFetch(
      host,
      token,
      "/courses?enrollment_state=active&include[]=enrollments&include[]=total_scores&include[]=current_grading_period_scores&per_page=100"
    );
  } catch {
    rows = await canvasFetch(
      host,
      token,
      "/courses?enrollment_state=active&per_page=100"
    );
  }
  if (!Array.isArray(rows)) return [];
  const mapped = rows.filter((c) => c && c.id && !c.access_restricted_by_date).map(mapCourse);
  return attachEnrollmentGrades(host, token, mapped);
}

function workFromSubmission(row) {
  const asg = row?.assignment || {};
  const title = String(asg.name || asg.title || "").trim();
  if (!title && !row?.assignment_id && !row?.id) return null;
  const score = numOrNull(row?.score);
  const pointsPossible = numOrNull(asg.points_possible);
  const submitted = Boolean(row?.submitted_at);
  const excused = Boolean(row?.excused);
  const missing = Boolean(row?.missing);
  const graded = String(row?.workflow_state || "").toLowerCase() === "graded" || score != null;
  if (!graded && !excused && !missing && !submitted) return null;
  return {
    id: String(asg.id || row.assignment_id || row.id || ""),
    title: title || "Assignment",
    score,
    grade: String(row?.grade || "").trim(),
    pointsPossible,
    due: String(asg.due_at || "").trim(),
    canvasLink: String(asg.html_url || row.preview_url || "").trim(),
    excused,
    missing,
    late: Boolean(row?.late),
    submitted,
    tag: inferTag({ ...asg, name: title, title }),
  };
}

async function listCourseWork(host, token, courseId) {
  const id = encodeURIComponent(String(courseId || ""));
  if (!id) return [];
  const rows = await canvasFetch(
    host,
    token,
    `/courses/${id}/students/submissions?student_ids[]=self&include[]=assignment&order=graded_at&order_direction=descending&per_page=40`,
    1
  );
  if (!Array.isArray(rows)) return [];
  return rows.map(workFromSubmission).filter(Boolean).slice(0, 40);
}

export async function listGrades(host, token, { work = false } = {}) {
  const courses = (await listCourses(host, token)).filter((c) => !isNonGradeCourse(c));
  if (!work) return courses.map((c) => ({ ...c, work: [] }));
  const head = await Promise.all(
    courses.slice(0, 12).map(async (c) => ({
      ...c,
      work: await listCourseWork(host, token, c.id).catch(() => []),
    }))
  );
  return [...head, ...courses.slice(12).map((c) => ({ ...c, work: [] }))];
}

function assignmentFromTodo(item, coursesById) {
  const asg = item?.assignment || item?.plannable || item;
  if (!asg || (!asg.id && !item.plannable_id)) return null;
  const courseId = String(
    asg.course_id || item.course_id || item.context_id || ""
  );
  const course = coursesById.get(courseId);
  const title = String(asg.name || asg.title || item.plannable?.title || "").trim();
  if (!title) return null;
  const canvasId = String(asg.id || item.plannable_id || "");
  const due = String(
    asg.due_at || item.plannable_date || item.due_at || ""
  ).trim();
  const done = Boolean(
    item.planner_override?.marked_complete ||
      asg.has_submitted_submissions ||
      asg.submitted_at ||
      item.submissions?.submitted
  );
  return {
    id: canvasId,
    canvasId,
    canvasLink: String(asg.html_url || item.html_url || "").trim(),
    title,
    courseName: course?.name || String(item.context_name || "").trim(),
    courseId,
    due,
    tag: inferTag({ ...asg, name: title, title }),
    done,
  };
}

function assignmentFromPlanner(item, coursesById) {
  const p = item?.plannable || {};
  const type = String(item?.plannable_type || "").toLowerCase();
  if (type && !/assignment|quiz|discussion|planner_note/.test(type)) return null;
  const canvasId = String(p.id || item.plannable_id || "");
  const title = String(p.title || p.name || "").trim();
  if (!canvasId || !title) return null;
  const courseId = String(item.course_id || item.context_id || p.course_id || "");
  const course = coursesById.get(courseId);
  return {
    id: canvasId,
    canvasId,
    canvasLink: String(item.html_url || p.html_url || "").trim(),
    title,
    courseName: course?.name || String(item.context_name || "").trim(),
    courseId,
    due: String(item.plannable_date || p.due_at || "").trim(),
    tag: inferTag({ ...p, name: title, title, plannable_type: type }),
    done: Boolean(item.planner_override?.marked_complete || item.submissions?.submitted),
  };
}

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export async function listAssignments(host, token) {
  const courses = await listCourses(host, token).catch(() => []);
  const coursesById = new Map(courses.map((c) => [c.id, c]));
  const seen = new Map();

  const add = (row) => {
    if (!row?.canvasId || seen.has(row.canvasId)) return;
    seen.set(row.canvasId, row);
  };

  try {
    const todo = await canvasFetch(host, token, "/users/self/todo?per_page=50");
    if (Array.isArray(todo)) todo.forEach((item) => add(assignmentFromTodo(item, coursesById)));
  } catch {
    // planner is the fallback
  }

  try {
    const start = encodeURIComponent(isoDaysFromNow(-7));
    const end = encodeURIComponent(isoDaysFromNow(45));
    const planner = await canvasFetch(
      host,
      token,
      `/planner/items?start_date=${start}&end_date=${end}&per_page=50`
    );
    if (Array.isArray(planner)) {
      planner.forEach((item) => add(assignmentFromPlanner(item, coursesById)));
    }
  } catch {
    // todo-only is fine
  }

  return [...seen.values()]
    .sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")))
    .slice(0, ASSIGN_CAP);
}

export async function dashboardPayload(host, token) {
  const self = await validateToken(host, token);
  const [courses, assignments] = await Promise.all([
    listCourses(host, token),
    listAssignments(host, token),
  ]);
  return { self, courses, assignments };
}
