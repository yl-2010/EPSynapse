/**
 * EPSynapse notes classifier.
 * BERT vs fine-tuned BERT, then the student's model maps onto their classes.
 */

import * as agent from "./agent.js";
import {
  PROVIDERS,
  MISSING_KEY_ERROR,
  explainUpstreamError,
  textFromModelField,
  upstreamHeaders,
} from "./agent.js";
import { classifyWithBert, normalizeBertVote } from "./bert.js";
import { matchClassForSubject } from "./schedule.js";
import {
  OTHER_SUBJECT,
  SUBJECTS_PLUS_OTHER,
  normalizeSubjectLabel,
} from "./subjects.js";

export function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function clampToAllowedSubject(raw) {
  const normalized = normalizeSubjectLabel(raw);
  if (!normalized) return OTHER_SUBJECT;
  if (SUBJECTS_PLUS_OTHER.includes(normalized)) return normalized;
  return OTHER_SUBJECT;
}

function classNamesFrom(classes) {
  const seen = new Set();
  const names = [];
  for (const c of classes || []) {
    const name = String(c?.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

function clampToClassLabel(raw, classNames) {
  const names = classNames || [];
  const trimmed = String(raw || "").trim();
  if (!trimmed) return OTHER_SUBJECT;
  const lower = trimmed.toLowerCase();
  if (lower === "other") return OTHER_SUBJECT;
  const exact = names.find((n) => n.toLowerCase() === lower);
  if (exact) return exact;
  const fuzzy = names.find((n) => {
    const nl = n.toLowerCase();
    return nl.includes(lower) || lower.includes(nl);
  });
  return fuzzy || OTHER_SUBJECT;
}

function classLine(klass) {
  const name = String(klass?.name || "").trim();
  if (!name) return "";
  const bits = [name];
  if (klass.period) bits.push(`period ${klass.period}`);
  if (klass.subject) bits.push(klass.subject);
  return `- ${bits.join(" · ")}`;
}

function parseCorrectFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  if (["true", "yes", "correct", "right"].includes(t)) return true;
  if (["false", "no", "incorrect", "wrong"].includes(t)) return false;
  return null;
}

function resolveStudentKeys(req, providerId, student) {
  if (typeof agent.resolveApiKeys === "function") {
    const resolved = agent.resolveApiKeys(req, providerId, student);
    return { keys: resolved.keys || [], source: resolved.source || "" };
  }
  const resolved = agent.resolveApiKey(req, providerId, student);
  return {
    keys: resolved?.key ? [resolved.key] : [],
    source: resolved?.source || "",
  };
}

function postJson(provider, useKey, system, user, extra) {
  return fetch(provider.url, {
    method: "POST",
    headers: upstreamHeaders(provider, useKey),
    body: JSON.stringify({
      model: provider.model,
      stream: false,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...extra,
    }),
    signal: AbortSignal.timeout(60_000),
  });
}

async function completeJson(req, student, system, user) {
  const providerId = String(student?.modelProvider || "groq");
  const provider = PROVIDERS[providerId] || PROVIDERS.groq;
  const { keys, source } = resolveStudentKeys(req, provider.id, student);
  if (!keys.length) {
    const err = new Error(MISSING_KEY_ERROR);
    err.status = 401;
    throw err;
  }

  const extra = { ...(provider.extraBody || {}) };
  delete extra.reasoning_effort;
  delete extra.reasoning;

  const started = Date.now();
  let upstream;
  try {
    if (typeof agent.fetchWithKeyCycle === "function") {
      const cycled = await agent.fetchWithKeyCycle(keys, (useKey) =>
        postJson(provider, useKey, system, user, extra)
      );
      upstream = cycled.response;
    } else {
      upstream = await postJson(provider, keys[0], system, user, extra);
    }
  } catch (err) {
    const timedOut = err && err.name === "TimeoutError";
    const fail = new Error(timedOut ? "The model timed out. Try again." : "Could not reach the model host.");
    fail.status = 502;
    throw fail;
  }

  if (!upstream) {
    const fail = new Error("Could not reach the model host.");
    fail.status = 502;
    throw fail;
  }

  const text = await upstream.text().catch(() => "");
  if (!upstream.ok) {
    const extraErr =
      typeof explainUpstreamError === "function"
        ? explainUpstreamError(upstream.status, text, { keyCount: keys.length })
        : `Model host returned ${upstream.status}`;
    const fail = new Error(extraErr);
    fail.status = upstream.status === 401 ? 401 : 502;
    throw fail;
  }

  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const content = textFromModelField(choice?.message?.content || choice?.message || "");
  return {
    content,
    model: json.model || provider.model,
    latencyMs: Date.now() - started,
    source,
    provider: provider.id,
  };
}

function agreementSubject(votes) {
  const scored = new Map();
  const bump = (vote, weight) => {
    if (!vote?.subject) return;
    const key = vote.subject;
    const conf = typeof vote.confidence === "number" ? vote.confidence : 0.5;
    scored.set(key, (scored.get(key) || 0) + weight * (0.5 + conf));
  };
  bump(votes.baseBert, 1);
  const ft = votes.fineTunedBert;
  const ftWeight = ft && typeof ft.confidence === "number" && ft.confidence >= 0.7 ? 1.8 : 1.15;
  bump(ft, ftWeight);
  let best = "";
  let bestScore = -1;
  for (const [subject, score] of scored) {
    if (score > bestScore) {
      best = subject;
      bestScore = score;
    }
  }
  return best || OTHER_SUBJECT;
}

export async function orchestrateWithStudentKey(rawText, votes, { req, student, classes } = {}) {
  const classNames = classNamesFrom(classes);
  const usingClasses = classNames.length > 0;
  const allowed = usingClasses ? [...classNames, OTHER_SUBJECT] : SUBJECTS_PLUS_OTHER;
  const system = usingClasses
    ? [
        "You orchestrate two subject classifiers for student notes.",
        "BERT and fine-tuned BERT each voted a coarse academic subject.",
        "First decide whether each vote is correct for these notes.",
        `Then pick exactly one of this student's classes: ${allowed.join(", ")}.`,
        "Do not invent a class name.",
        "Map a correct coarse subject onto the matching class.",
        "If both votes are wrong, still pick the best class from the notes.",
        "Use Other only when none of the classes fit.",
        "Respond with a single JSON object only, no markdown.",
        'Schema: {"baseBertCorrect": boolean, "fineTunedBertCorrect": boolean, "subject": string, "confidence": number, "rationale": string}',
        "confidence is 0..1.",
      ].join(" ")
    : [
        "You orchestrate two subject classifiers for student notes.",
        "BERT and fine-tuned BERT each voted a coarse academic subject.",
        "First decide whether each vote is correct for these notes.",
        `Then pick exactly one of: ${SUBJECTS_PLUS_OTHER.join(", ")}.`,
        "Do not invent a new subject name.",
        "Prefer a vote you judged correct. If they agree and both look right, use that subject.",
        "If they disagree, trust the notes.",
        "Respond with a single JSON object only, no markdown.",
        'Schema: {"baseBertCorrect": boolean, "fineTunedBertCorrect": boolean, "subject": string, "confidence": number, "rationale": string}',
        "confidence is 0..1.",
      ].join(" ");

  const classBlock = usingClasses
    ? ["Student classes:", ...(classes || []).map(classLine).filter(Boolean), ""]
    : [];

  const user = [
    ...classBlock,
    "Classifier votes (JSON):",
    JSON.stringify(
      {
        baseBert: votes.baseBert,
        fineTunedBert: votes.fineTunedBert,
      },
      null,
      2
    ),
    "",
    "Notes:",
    String(rawText || "").slice(0, 8000),
  ].join("\n");

  const result = await completeJson(req, student, system, user);
  const parsed = extractJsonObject(result.content) || {};
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    subject: usingClasses
      ? clampToClassLabel(parsed.subject, classNames)
      : clampToAllowedSubject(parsed.subject),
    confidence,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    model: result.model,
    latencyMs: result.latencyMs,
    baseBertCorrect: parseCorrectFlag(parsed.baseBertCorrect),
    fineTunedBertCorrect: parseCorrectFlag(parsed.fineTunedBertCorrect),
  };
}

export async function classifyEnsemble(rawText, { req, student, classes } = {}) {
  const bertResult = await classifyWithBert(rawText);

  let bertStatus = { status: "ok" };
  let baseBert = null;
  let fineTunedBert = null;
  if (!bertResult.ok) {
    bertStatus = { status: "unavailable", error: bertResult.error };
  } else {
    baseBert = normalizeBertVote(bertResult.votes?.zeroShotBert);
    fineTunedBert = normalizeBertVote(bertResult.votes?.fineTunedBert);
    if (!fineTunedBert && bertResult.fineTunedError) {
      bertStatus = {
        status: "partial",
        error: bertResult.fineTunedError,
        zeroShotOk: Boolean(baseBert),
        fineTunedOk: false,
      };
    }
  }

  const votes = { baseBert, fineTunedBert };

  let orchestrator;
  try {
    orchestrator = await orchestrateWithStudentKey(rawText, votes, { req, student, classes });
  } catch (err) {
    const agreed = agreementSubject(votes);
    const fallback = classNamesFrom(classes).length
      ? matchClassForSubject(classes, agreed)?.name || OTHER_SUBJECT
      : agreed;
    const conf =
      (fineTunedBert && fineTunedBert.confidence) ||
      (baseBert && baseBert.confidence) ||
      0.4;
    orchestrator = {
      subject: fallback,
      confidence: conf,
      rationale: `Orchestrator used BERT agreement (${err?.message || "no student key"}).`,
      model: "",
      latencyMs: 0,
      degraded: true,
      baseBertCorrect: null,
      fineTunedBertCorrect: null,
    };
  }

  return {
    subject: orchestrator.subject,
    confidence: orchestrator.confidence,
    rationale: orchestrator.rationale,
    model: orchestrator.model,
    latencyMs: orchestrator.latencyMs,
    votes,
    orchestrator,
    bert: bertStatus,
  };
}
