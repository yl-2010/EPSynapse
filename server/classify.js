/**
 * EPSynapse notes classifier ensemble.
 * BERT sidecar + student-key model, then student-key orchestrator.
 */

import {
  PROVIDERS,
  explainUpstreamError,
  resolveApiKey,
  textFromModelField,
  upstreamHeaders,
} from "./agent.js";
import { classifyWithBert, normalizeBertVote } from "./bert.js";
import {
  FIXED_SUBJECTS,
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

function clampToFixedSubject(raw) {
  const normalized = normalizeSubjectLabel(raw);
  if (normalized && FIXED_SUBJECTS.includes(normalized)) return normalized;
  return FIXED_SUBJECTS[0];
}

function clampToAllowedSubject(raw) {
  const normalized = normalizeSubjectLabel(raw);
  if (!normalized) return OTHER_SUBJECT;
  if (SUBJECTS_PLUS_OTHER.includes(normalized)) return normalized;
  return OTHER_SUBJECT;
}

async function completeJson(req, student, system, user) {
  const providerId = String(student?.modelProvider || "groq");
  const provider = PROVIDERS[providerId] || PROVIDERS.groq;
  const { key, source } = resolveApiKey(req, provider.id, student);
  if (!key) {
    const err = new Error(
      "Paste a free API key first. Groq is the fastest signup: console.groq.com/keys"
    );
    err.status = 401;
    throw err;
  }

  const extra = { ...(provider.extraBody || {}) };
  delete extra.reasoning_effort;
  delete extra.reasoning;

  const started = Date.now();
  let upstream;
  try {
    upstream = await fetch(provider.url, {
      method: "POST",
      headers: upstreamHeaders(provider, key),
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
  } catch (err) {
    const timedOut = err && err.name === "TimeoutError";
    const fail = new Error(timedOut ? "The model timed out. Try again." : "Could not reach the model host.");
    fail.status = 502;
    throw fail;
  }

  const text = await upstream.text().catch(() => "");
  if (!upstream.ok) {
    const fail = new Error(explainUpstreamError(upstream.status, text));
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

export async function classifyWithStudentKey(rawText, { req, student } = {}) {
  const system = [
    "You classify student study notes into academic subjects.",
    `You MUST pick exactly one of these eight subjects: ${FIXED_SUBJECTS.join(", ")}.`,
    `Do not invent subjects. Do not use "${OTHER_SUBJECT}" or any custom label.`,
    "If the notes are a poor fit, still choose the closest of the eight.",
    "Respond with a single JSON object only, no markdown.",
    'Schema: {"subject": string, "confidence": number, "rationale": string}',
    "confidence is 0..1.",
  ].join(" ");

  const result = await completeJson(
    req,
    student,
    system,
    ["Notes:", String(rawText || "").slice(0, 12000)].join("\n")
  );
  const parsed = extractJsonObject(result.content) || {};
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    subject: clampToFixedSubject(parsed.subject),
    confidence,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    model: result.model,
    latencyMs: result.latencyMs,
    source: result.source,
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
  bump(votes.studentKey, 1.1);
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

export async function orchestrateWithStudentKey(rawText, votes, { req, student } = {}) {
  const system = [
    "You are an orchestrator that picks the final academic subject for student notes.",
    `Pick exactly one of: ${SUBJECTS_PLUS_OTHER.join(", ")}.`,
    "Do not invent a new subject name.",
    "Prefer agreement among the three votes.",
    "Weigh fine-tuned BERT highly when its confidence is strong.",
    "Respond with a single JSON object only, no markdown.",
    'Schema: {"subject": string, "confidence": number, "rationale": string}',
    "confidence is 0..1.",
  ].join(" ");

  const user = [
    "Votes (JSON):",
    JSON.stringify(
      {
        baseBert: votes.baseBert,
        fineTunedBert: votes.fineTunedBert,
        studentKey: votes.studentKey,
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
    subject: clampToAllowedSubject(parsed.subject),
    confidence,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
    model: result.model,
    latencyMs: result.latencyMs,
  };
}

export async function classifyEnsemble(rawText, { req, student } = {}) {
  const [studentVote, bertResult] = await Promise.all([
    classifyWithStudentKey(rawText, { req, student }).catch((err) => ({
      error: err?.message || "student-key model failed",
      status: err?.status || 502,
    })),
    classifyWithBert(rawText),
  ]);

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

  const studentKey =
    studentVote && studentVote.subject
      ? {
          subject: studentVote.subject,
          confidence: studentVote.confidence,
          rationale: studentVote.rationale || "",
          model: studentVote.model,
          latencyMs: studentVote.latencyMs,
        }
      : null;

  const votes = { baseBert, fineTunedBert, studentKey };

  let orchestrator;
  try {
    if (!studentKey) throw new Error(studentVote?.error || "No student-key vote.");
    orchestrator = await orchestrateWithStudentKey(rawText, votes, { req, student });
  } catch (err) {
    const fallback = agreementSubject(votes);
    const conf =
      (fineTunedBert && fineTunedBert.confidence) ||
      (studentKey && studentKey.confidence) ||
      (baseBert && baseBert.confidence) ||
      0.4;
    orchestrator = {
      subject: fallback,
      confidence: conf,
      rationale: `Orchestrator used vote agreement (${err?.message || "no student key"}).`,
      model: studentVote?.model || "",
      latencyMs: 0,
      degraded: true,
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
    studentKeyError: studentVote?.error || null,
  };
}
