/**
 * Client for the local EPSynapse notes-classifier BERT sidecar.
 * 127.0.0.1:3007 only. Auto-spawns scripts/bert_serve.py via the JYPE .venv.
 *
 * Off unless BERT_ENABLED=1. Notes are classified by the student's own model key
 * (classify.js orchestrator) with no BERT votes. The sidecar, the training scripts,
 * and models/ stay in the repo so it can come back with one env var.
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "http://127.0.0.1:3007";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = "/tmp/jype-bert.log";
const DEFAULT_READY_TIMEOUT_MS = 180_000;

/** @type {Promise<object>|null} */
let ensuring = null;

export function bertEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.BERT_ENABLED || "").trim());
}

export function getBertServiceUrl() {
  return (process.env.BERT_SERVICE_URL || DEFAULT_URL).replace(/\/$/, "");
}

function getBertPort() {
  try {
    return Number(new URL(getBertServiceUrl()).port) || 3007;
  } catch {
    return 3007;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bertProcessRunning() {
  try {
    execFileSync("pgrep", ["-f", "scripts/bert_serve.py"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function spawnBertService() {
  const python = path.join(ROOT, ".venv", "bin", "python");
  const script = path.join(ROOT, "scripts", "bert_serve.py");
  if (!fs.existsSync(python)) {
    throw new Error(`BERT venv missing at ${python}`);
  }
  if (!fs.existsSync(script)) {
    throw new Error(`BERT script missing at ${script}`);
  }

  const out = fs.openSync(LOG_PATH, "a");
  const child = spawn(python, [script], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      BERT_HOST: "127.0.0.1",
      BERT_PORT: String(getBertPort()),
    },
  });
  child.unref();
  console.log(`[bert] spawned pid=${child.pid} (log ${LOG_PATH})`);
  return child;
}

export async function ensureBertService({
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
} = {}) {
  const already = await probeBertService();
  if (already.ok && already.zeroShotLoaded) return already;

  if (!ensuring) {
    ensuring = (async () => {
      try {
        let probe = await probeBertService();
        if (probe.ok && probe.zeroShotLoaded) return probe;

        if (!bertProcessRunning()) {
          spawnBertService();
        } else {
          console.log("[bert] process present; waiting for models to load…");
        }

        const deadline = Date.now() + readyTimeoutMs;
        while (Date.now() < deadline) {
          await sleep(1500);
          probe = await probeBertService();
          if (probe.ok && probe.zeroShotLoaded) {
            console.log("[bert] service ready");
            return probe;
          }
        }

        throw new Error(
          `BERT service did not become ready within ${readyTimeoutMs}ms` +
            (probe?.error ? ` (${probe.error})` : "")
        );
      } finally {
        ensuring = null;
      }
    })();
  }

  return ensuring;
}

export async function classifyWithBert(rawText, { timeoutMs = 120_000 } = {}) {
  if (!bertEnabled()) {
    return { ok: false, status: "off", error: "BERT is off (BERT_ENABLED unset)" };
  }
  try {
    await ensureBertService({
      readyTimeoutMs: Math.max(timeoutMs, DEFAULT_READY_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: "unavailable",
      error: err?.message || "BERT service failed to start",
    };
  }

  const base = getBertServiceUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(rawText || "").slice(0, 20000) }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        status: "unavailable",
        error: data?.error || `BERT service HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      votes: data.votes || {},
      fineTunedError: data.fineTunedError ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      status: "unavailable",
      error:
        err?.name === "AbortError"
          ? "BERT service timeout"
          : err?.message || "BERT fetch failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeBertService() {
  if (!bertEnabled()) return { ok: false, enabled: false, error: "off" };
  const base = getBertServiceUrl();
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data?.ok === true, ...data };
  } catch (err) {
    return { ok: false, error: err?.message || "unreachable" };
  }
}

export function normalizeBertVote(vote) {
  if (!vote || typeof vote !== "object") return null;
  return {
    subject: vote.subject ?? null,
    confidence: typeof vote.confidence === "number" ? vote.confidence : null,
    probs: vote.probs ?? null,
    latencyMs: vote.latencyMs ?? null,
    protocol: vote.protocol ?? null,
    model: vote.model ?? null,
  };
}
