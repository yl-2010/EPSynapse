/**
 * Public research metrics for the EPSynapse notes classifier.
 * Pools frozen eval with live user events. Never returns raw note text.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listResearchEvents } from "./notes.js";
import { FIXED_SUBJECTS, isFixedSubject, normalizeSubjectLabel } from "./subjects.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_FROZEN_PATHS = [
  path.join(REPO_ROOT, "research-metrics.json"),
  path.join(__dirname, "data", "research-metrics.json"),
];

const ARM_META = {
  zero_shot: { label: "Zero-shot BERT", voteKey: "baseBert" },
  fine_tuned: { label: "Fine-tuned BERT", voteKey: "fineTunedBert" },
  student_key: { label: "Student-key model", voteKey: "studentKey" },
};

const ARM_KEYS = Object.keys(ARM_META);

function emptyCounts() {
  const byClass = {};
  for (const s of FIXED_SUBJECTS) {
    byClass[s] = { tp: 0, fp: 0, fn: 0, support: 0 };
  }
  return { n: 0, correct: 0, byClass };
}

export function countsFromPerClass(perClass) {
  const counts = emptyCounts();
  if (!perClass || typeof perClass !== "object") return counts;

  for (const s of FIXED_SUBJECTS) {
    const row = perClass[s];
    if (!row) continue;
    const support = Math.max(0, Math.round(Number(row.support) || 0));
    const recall = Number(row.recall);
    const precision = Number(row.precision);
    const tp = Number.isFinite(recall) ? Math.max(0, Math.round(recall * support)) : 0;
    let fp = 0;
    if (Number.isFinite(precision) && precision > 0) {
      const predPos = Math.round(tp / precision);
      fp = Math.max(0, predPos - tp);
    }
    const fn = Math.max(0, support - tp);
    counts.byClass[s] = { tp, fp, fn, support };
    counts.n += support;
    counts.correct += tp;
  }
  return counts;
}

export function addPrediction(counts, gold, pred) {
  const g = normalizeSubjectLabel(gold);
  const p = normalizeSubjectLabel(pred);
  if (!isFixedSubject(g) || !p) return false;
  counts.n += 1;
  counts.byClass[g].support += 1;
  if (p === g) {
    counts.correct += 1;
    counts.byClass[g].tp += 1;
    return true;
  }
  counts.byClass[g].fn += 1;
  if (isFixedSubject(p)) {
    counts.byClass[p].fp += 1;
  }
  return true;
}

export function mergeCounts(a, b) {
  const out = emptyCounts();
  out.n = a.n + b.n;
  out.correct = a.correct + b.correct;
  for (const s of FIXED_SUBJECTS) {
    out.byClass[s] = {
      tp: a.byClass[s].tp + b.byClass[s].tp,
      fp: a.byClass[s].fp + b.byClass[s].fp,
      fn: a.byClass[s].fn + b.byClass[s].fn,
      support: a.byClass[s].support + b.byClass[s].support,
    };
  }
  return out;
}

function safeDiv(num, den) {
  return den > 0 ? num / den : 0;
}

export function summarizeCounts(counts, name, extra = {}) {
  const per_class = {};
  const f1s = [];
  for (const s of FIXED_SUBJECTS) {
    const { tp, fp, fn, support } = counts.byClass[s];
    const precision = safeDiv(tp, tp + fp);
    const recall = safeDiv(tp, tp + fn);
    const f1 = safeDiv(2 * precision * recall, precision + recall);
    per_class[s] = { precision, recall, f1, support };
    f1s.push(f1);
  }
  const accuracy = safeDiv(counts.correct, counts.n);
  const macro_f1 = f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : 0;
  return {
    name,
    n: counts.n,
    accuracy,
    micro_f1: accuracy,
    macro_f1,
    per_class,
    ...extra,
  };
}

export function goldFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  const gold = normalizeSubjectLabel(event.userGoldSubject || event.finalSubject);
  return isFixedSubject(gold) ? gold : null;
}

export function predFromEvent(event, armKey) {
  const meta = ARM_META[armKey];
  if (!meta || !event) return null;
  const vote = event.votes?.[meta.voteKey];
  const subject = normalizeSubjectLabel(vote?.subject);
  return subject || null;
}

export function accumulateUserEvents(events) {
  const byArm = Object.fromEntries(ARM_KEYS.map((k) => [k, emptyCounts()]));
  let used = 0;
  for (const event of events || []) {
    const gold = goldFromEvent(event);
    if (!gold) continue;
    let any = false;
    for (const armKey of ARM_KEYS) {
      const pred = predFromEvent(event, armKey);
      if (!pred) continue;
      if (addPrediction(byArm[armKey], gold, pred)) any = true;
    }
    if (any) used += 1;
  }
  return { byArm, used };
}

export async function loadFrozenMetrics(filePath) {
  const paths = filePath ? [filePath] : DEFAULT_FROZEN_PATHS;
  for (const p of paths) {
    try {
      return JSON.parse(await fs.readFile(p, "utf8"));
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
  }
  return emptyFrozen();
}

function emptyFrozen() {
  const per_class = {};
  for (const s of FIXED_SUBJECTS) {
    per_class[s] = { precision: 0, recall: 0, f1: 0, support: 0 };
  }
  const arm = (name, label) => ({
    name,
    n: 0,
    accuracy: 0,
    micro_f1: 0,
    macro_f1: 0,
    per_class: { ...per_class },
    label,
  });
  return {
    subjects: [...FIXED_SUBJECTS],
    test_n: 0,
    arms: {
      zero_shot: arm("zero_shot", ARM_META.zero_shot.label),
      fine_tuned: arm("fine_tuned", ARM_META.fine_tuned.label),
      student_key: arm("student_key", ARM_META.student_key.label),
    },
    updated_at: null,
  };
}

function stripUnsafe(payload) {
  const { text, notes, events, raw, ...safe } = payload || {};
  return safe;
}

export async function buildResearchMetrics({
  includeFrozen = true,
  includeUser = false,
  userEvents = [],
  frozen = null,
  frozenPath,
} = {}) {
  let useFrozen = includeFrozen !== false;
  let useUser = Boolean(includeUser);
  if (!useFrozen && !useUser) useFrozen = true;

  const base = frozen || (await loadFrozenMetrics(frozenPath));
  const subjects = Array.isArray(base.subjects) ? base.subjects : [...FIXED_SUBJECTS];
  const { byArm: userByArm, used: userTestN } = accumulateUserEvents(userEvents);
  const frozenN = typeof base.test_n === "number" ? base.test_n : 0;

  if (useFrozen && !useUser) {
    return stripUnsafe({
      ...base,
      subjects,
      include_user_tests: false,
      include_frozen_tests: true,
      user_test_n: userTestN,
      frozen_test_n: frozenN,
      source: "frozen_eval",
    });
  }

  const arms = {};
  for (const armKey of ARM_KEYS) {
    const frozenArm = base.arms?.[armKey] || {};
    const frozenCounts = useFrozen
      ? countsFromPerClass(frozenArm.per_class)
      : emptyCounts();
    const userCounts = userByArm[armKey];
    const merged = useFrozen ? mergeCounts(frozenCounts, userCounts) : userCounts;
    const meta = ARM_META[armKey];
    arms[armKey] = summarizeCounts(merged, armKey, {
      label: frozenArm.label || meta.label,
      protocol: frozenArm.protocol,
      model: frozenArm.model,
      frozen_n: useFrozen ? (frozenArm.n ?? frozenCounts.n) : 0,
      user_n: userCounts.n,
    });
  }

  const sources = [];
  if (useFrozen) sources.push("frozen_eval");
  if (useUser) sources.push("user_tests");

  return stripUnsafe({
    subjects,
    test_n: (useFrozen ? frozenN : 0) + userTestN,
    arms,
    updated_at: new Date().toISOString(),
    frozen_updated_at: base.updated_at || null,
    include_user_tests: useUser,
    include_frozen_tests: useFrozen,
    user_test_n: userTestN,
    frozen_test_n: useFrozen ? frozenN : 0,
    source: sources.join("+"),
  });
}

export function mountResearch(app, { fail }) {
  app.get("/v1/research/metrics", async (req, res) => {
    try {
      const includeUser =
        req.query.includeUser === "1" || req.query.includeUser === "true";
      const includeFrozen =
        req.query.includeFrozen === undefined
          ? true
          : req.query.includeFrozen === "1" || req.query.includeFrozen === "true";
      const userEvents = includeUser ? await listResearchEvents() : [];
      const payload = await buildResearchMetrics({
        includeFrozen,
        includeUser,
        userEvents,
      });
      return res.json(payload);
    } catch (err) {
      return fail(res, err);
    }
  });
}

export { ARM_KEYS, ARM_META, DEFAULT_FROZEN_PATHS };
