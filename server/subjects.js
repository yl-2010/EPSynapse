/**
 * Eight-subject taxonomy for the EPSynapse notes classifier.
 * Student-key orchestrator may also pick Other.
 */

export const FIXED_SUBJECTS = [
  "Mathematics",
  "Physics",
  "Chemistry",
  "Biology",
  "Computer Science",
  "History",
  "Literature",
  "Economics",
];

export const OTHER_SUBJECT = "Other";

export const SUBJECTS_PLUS_OTHER = [...FIXED_SUBJECTS, OTHER_SUBJECT];

export function isFixedSubject(label) {
  return FIXED_SUBJECTS.includes(label);
}

export function isKnownSubject(label) {
  return SUBJECTS_PLUS_OTHER.includes(label);
}

export function normalizeSubjectLabel(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const s of FIXED_SUBJECTS) {
    if (s.toLowerCase() === lower) return s;
  }
  if (lower === "other") return OTHER_SUBJECT;
  return trimmed;
}

const NAME_HINTS = [
  [/calculus|algebra|geometry|statistics|precalc|trig|math/i, "Mathematics"],
  [/physics/i, "Physics"],
  [/chem/i, "Chemistry"],
  [/bio/i, "Biology"],
  [/computer|programming|coding|\bcs\b|software/i, "Computer Science"],
  [/history|civics|government|politics/i, "History"],
  [/literature|english|writing|poetry/i, "Literature"],
  [/econ/i, "Economics"],
];

export function subjectFromCourseName(name) {
  const text = String(name || "");
  for (const [re, subject] of NAME_HINTS) {
    if (re.test(text)) return subject;
  }
  return "";
}

/** Map a class name or taxonomy label onto the eight research subjects. */
export function taxonomyFromLabel(raw) {
  const direct = normalizeSubjectLabel(raw);
  if (isFixedSubject(direct)) return direct;
  const mapped = subjectFromCourseName(raw);
  return isFixedSubject(mapped) ? mapped : null;
}
