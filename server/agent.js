/**
 * Student personal-agent proxy.
 * Students paste their own free key. It lives on the Google account.
 * Optional DEMO_GROQ_KEY covers the table if nobody has pasted one yet.
 */

import { googleFileId } from "./students.js";

export const SYSTEM_PROMPT = [
  "You are the EPSynapse personal agent for Eastside Prep students.",
  "Be direct and useful. Skip filler.",
  "Help with school life: classes, homework planning, LPC, EBC, clubs, college-counseling questions they can take to an adult.",
  "You can change the student's dashboard with tools: add/update/delete notes, add/update/check/uncheck/delete todos, add/edit/delete files on a todo page or a class page including standalone HTML, and rename classes.",
  "When they ask you to do one of those things, call the tool. Do not tell them to tap a button instead.",
  "If a live student snapshot is attached, use it. Do not invent courses, due dates, grades, files, or emails that are not in the snapshot or a tool result.",
  "If an open screen is attached, that class or note is the default edit target unless they name something else. Skip open_page when they are already on that page.",
  "After a create, call open_page so the site or app lands on that class or note.",
  "If they want mail sent, tell them to use the Mail panel Send button. You cannot send from chat.",
  "If there is no snapshot, say you do not have live school data yet.",
  "If they ask about a bubble that said it could not reach api.epsynapse.com, or why a normal question (an emoji, homework, a book chapter, anything) got no model answer: that text is a browser or app catch, not a refusal. The public site and the API are different hosts. Chat POSTs to api.epsynapse.com, a Mac process on port 3006 published through a Cloudflare tunnel. A first reply can work and a follow-up still fail, because the second ask sends the whole thread and the Mac can stay quiet long enough that the tunnel drops. When that fetch throws, the model never ran. Tell them to retry. If it keeps failing, the tunnel or the Mac API is down. Do not treat the original question as blocked or unsafe.",
  "If they ask why chat stopped, why Groq failed, or why a new key fixed it: Groq free keys get rejected when copied short, deleted, or replaced. They also hit a free limit of about 30 chats a minute and 1000 a day, or a token burst. Limits sit on the Groq login, so a second key on the same Groq account does not reset a daily cap. A new key helps when the old one was rejected, or when they used a different Groq login. Tell them to create a gsk_ at console.groq.com/keys, paste it in Settings Chat key, wait, add a key from another Groq login, or switch Model to Gemini. Full steps are on epsynapse.com/groq. Do not ask them to paste the key in chat.",
  "School mutations: 1-3 short lines. No period when the reply is one word, one phrase, or one sentence.",
  "Write the bubble in markdown: headings, lists, bold, italics, code, tables. For math use LaTeX: $inline$ and $$display$$, or \\(inline\\) and \\[display\\]. Never HTML tags or markdown images.",
].join(" ");

export const PROVIDERS = {
  groq: {
    id: "groq",
    label: "Groq",
    model: "openai/gpt-oss-120b",
    url: "https://api.groq.com/openai/v1/chat/completions",
    signup: "https://console.groq.com/keys",
    signupLabel: "console.groq.com/keys",
    blurb: "Google sign-in, no card. Reasoning model. About 1000 chats a day on the free tier.",
    recommended: true,
    extraBody: { reasoning_effort: "medium" },
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    model: "gemini-2.5-flash",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    signup: "https://aistudio.google.com/apikey",
    signupLabel: "aistudio.google.com/apikey",
    blurb: "School Google account. Stronger thinking. Google may use free-tier prompts to improve the product.",
    extraBody: { reasoning_effort: "medium" },
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    model: "openrouter/free",
    url: "https://openrouter.ai/api/v1/chat/completions",
    signup: "https://openrouter.ai/settings/keys",
    signupLabel: "openrouter.ai/settings/keys",
    blurb: "One key, rotating free models. Roughly 50 chats a day unless they add $10.",
    extraHeaders: {
      "HTTP-Referer": "https://epsynapse.com",
      "X-Title": "EPSynapse",
    },
    extraBody: { reasoning: { enabled: true } },
  },
};

const MAX_MESSAGES = 40;
const MAX_CONTENT = 8000;
const ALLOWED_ROLES = new Set(["user", "assistant"]);

const KEY_COOLDOWN_MS = 15 * 60 * 1000;
const KEY_COOLDOWN_MAX_MS = 60 * 60 * 1000;
const keyCooldown = new Map();

/**
 * The shared demo Groq pool is one login's free quota for the whole table.
 * Each student gets this many completions from it per UTC day; after that they
 * need their own key. In-memory, so a restart resets the count.
 */
export const DEMO_DAILY_CAP = 60;
export const DEMO_CAP_ERROR = "Add your own model key in Settings to keep going.";
const demoUsage = new Map();

function utcDayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function demoUsageId(student) {
  const sub = String(student?.googleSub || "").trim();
  if (sub) return googleFileId(sub);
  const email = String(student?.email || student?.googleEmail || "").trim().toLowerCase();
  return email ? `email__${email}` : "";
}

function demoCapError() {
  const err = new Error(DEMO_CAP_ERROR);
  err.status = 429;
  err.code = "demo_cap";
  return err;
}

/** Completions this student has used from the demo pool today. */
export function demoUsageToday(student, now = new Date()) {
  const id = demoUsageId(student);
  if (!id) return 0;
  const row = demoUsage.get(id);
  return row && row.day === utcDayKey(now) ? row.count : 0;
}

/**
 * Count one demo-pool completion for this student. Throws a 429 with
 * DEMO_CAP_ERROR once they pass DEMO_DAILY_CAP for the current UTC day.
 */
export function consumeDemoCompletion(student, now = new Date()) {
  const id = demoUsageId(student);
  if (!id) throw demoCapError();
  const day = utcDayKey(now);
  if (demoUsage.size > 5000) {
    for (const [key, row] of demoUsage) if (row.day !== day) demoUsage.delete(key);
  }
  const row = demoUsage.get(id);
  const count = row && row.day === day ? row.count : 0;
  if (count >= DEMO_DAILY_CAP) throw demoCapError();
  demoUsage.set(id, { day, count: count + 1 });
  return DEMO_DAILY_CAP - (count + 1);
}

export function demoGroqKeys() {
  const raw = [process.env.DEMO_GROQ_KEYS, process.env.DEMO_GROQ_KEY].filter(Boolean).join(",");
  const seen = new Set();
  const out = [];
  for (const part of raw.split(/[\s,]+/)) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function publicAgentConfig() {
  return {
    demo: { groq: demoGroqKeys().length > 0 },
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      model: p.model,
      signup: p.signup,
      signupLabel: p.signupLabel,
      blurb: p.blurb,
      recommended: Boolean(p.recommended),
    })),
  };
}

export const MISSING_KEY_ERROR =
  "Do not paste a key in this chat. Sign in with Google, tap the bottom-left gear, open Chat key, paste a free gsk_ key from console.groq.com/keys, tap Save key, wait until Chat key says Groq, then ask here.";

function keyFingerprint(key) {
  return String(key || "").slice(-12);
}

export function parseRetryAfterHeaderMs(res) {
  const raw = res?.headers?.get?.("retry-after");
  if (!raw) return 0;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) {
    return Math.min(Math.max(sec * 1000, 500), KEY_COOLDOWN_MAX_MS);
  }
  const when = Date.parse(raw);
  if (Number.isFinite(when)) {
    return Math.min(Math.max(when - Date.now(), 500), KEY_COOLDOWN_MAX_MS);
  }
  return 0;
}

export function parseRetryAfterBody(text) {
  const raw = groqBodyHint(text);
  const sec = raw.match(/try again in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (sec) {
    return Math.min(Math.max(Number(sec[1]) * 1000, 500), KEY_COOLDOWN_MAX_MS);
  }
  const min = raw.match(/try again in\s+(\d+)\s*m(?:in(?:ute)?s?)?(?:\s*(\d+(?:\.\d+)?)\s*s)?/i);
  if (min) {
    const ms = Number(min[1]) * 60_000 + (min[2] ? Number(min[2]) * 1000 : 0);
    return Math.min(Math.max(ms, 500), KEY_COOLDOWN_MAX_MS);
  }
  return 0;
}

export function parseRetryAfterMs(res, text = "") {
  return parseRetryAfterHeaderMs(res) || parseRetryAfterBody(text) || KEY_COOLDOWN_MS;
}

export function parseLimitWindow(text) {
  const hint = groqBodyHint(text).toLowerCase();
  if (/tokens per\s*(min|minute)|\btpm\b/.test(hint)) return "tpm";
  if (/requests per\s*(min|minute)|\brpm\b/.test(hint)) return "rpm";
  if (/requests per\s*day|\brpd\b/.test(hint)) return "rpd";
  if (/tokens per\s*day|\btpd\b/.test(hint)) return "tpd";
  return "";
}

export function isContextOverflow(status, text) {
  if (Number(status) === 429) return false;
  const hint = groqBodyHint(text).toLowerCase();
  return /context length|context window|maximum context|prompt is too long|too many tokens|tokens per request/.test(
    hint
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function replayResponse(response, text) {
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function markKeyLimited(key, ms) {
  const id = keyFingerprint(key);
  if (!id) return;
  keyCooldown.set(id, Date.now() + (Number(ms) || KEY_COOLDOWN_MS));
}

export function isKeyLimited(key) {
  const id = keyFingerprint(key);
  if (!id) return false;
  const until = keyCooldown.get(id);
  if (!until) return false;
  if (until <= Date.now()) {
    keyCooldown.delete(id);
    return false;
  }
  return true;
}

export function pickApiKey(keys, startIndex = 0) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
  if (!list.length) return { key: "", index: -1 };
  const n = list.length;
  const start = ((Number(startIndex) || 0) % n + n) % n;
  for (let i = 0; i < n; i += 1) {
    const idx = (start + i) % n;
    if (!isKeyLimited(list[idx])) return { key: list[idx], index: idx };
  }
  return { key: list[start], index: start };
}

export function studentStoredKeys(student) {
  const seen = new Set();
  const out = [];
  const add = (raw) => {
    const key = String(raw || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  if (Array.isArray(student?.modelKeys)) student.modelKeys.forEach(add);
  add(student?.modelKey);
  return out;
}

export function resolveApiKeys(req, providerId, student) {
  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const stored = studentStoredKeys(student);
  const seen = new Set();
  const keys = [];
  const add = (raw) => {
    const key = String(raw || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  add(bearer);
  stored.forEach(add);
  if (providerId === "groq" && keys.length === 0) demoGroqKeys().forEach(add);
  let source = "none";
  if (bearer) source = "student";
  else if (stored.length) source = "account";
  else if (keys.length) source = "demo";
  if (source === "demo") {
    // Each resolve is one completion for the student. Over the daily cap the
    // demo keys are withheld and `capError` (status 429) says why. Callers that
    // only look at keys.length fall through to their missing-key reply.
    try {
      consumeDemoCompletion(student);
    } catch (capError) {
      return { keys: [], source, capped: true, capError };
    }
  }
  return { keys, source, capped: false, capError: null };
}

export function resolveApiKey(req, providerId, student) {
  const { keys, source } = resolveApiKeys(req, providerId, student);
  const picked = pickApiKey(keys);
  return { key: picked.key, source, keys, index: picked.index };
}

export async function fetchWithKeyCycle(keys, makeRequest) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
  if (!list.length) return { response: null, key: "", attempts: 0 };
  let last = null;
  let lastKey = "";
  const tried = new Set();
  let start = 0;
  while (tried.size < list.length) {
    const picked = pickApiKey(list, start);
    if (!picked.key || tried.has(picked.index)) break;
    lastKey = picked.key;
    let sameRetries = 0;
    let moveOn = false;
    while (!moveOn) {
      const response = await makeRequest(picked.key);
      if (!response) {
        tried.add(picked.index);
        return { response: null, key: picked.key, attempts: tried.size };
      }
      if (response.ok) {
        tried.add(picked.index);
        return { response, key: picked.key, attempts: tried.size };
      }
      const text = await response.text().catch(() => "");
      last = replayResponse(response, text);
      const status = response.status;
      const window = parseLimitWindow(text);
      const retryAfterMs =
        parseRetryAfterHeaderMs(response) ||
        parseRetryAfterBody(text) ||
        (status === 429 ? (window === "rpd" || window === "tpd" ? KEY_COOLDOWN_MS : 8_000) : 0);
      const shortWait =
        status === 429 &&
        retryAfterMs > 0 &&
        retryAfterMs <= 25_000 &&
        window !== "rpd" &&
        window !== "tpd";
      if (shortWait && sameRetries < 2) {
        sameRetries += 1;
        console.warn(`[agent] groq 429 ${window || "burst"} wait ${retryAfterMs}ms retry ${sameRetries}`);
        await sleep(retryAfterMs);
        continue;
      }
      const cycle = status === 429 || status === 401 || status === 403;
      tried.add(picked.index);
      if (!cycle || tried.size >= list.length) {
        return { response: last, key: picked.key, attempts: tried.size };
      }
      if (status === 429) {
        markKeyLimited(picked.key, retryAfterMs || KEY_COOLDOWN_MS);
      }
      start = picked.index + 1;
      moveOn = true;
    }
  }
  return { response: last, key: lastKey, attempts: tried.size };
}

export function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && ALLOWED_ROLES.has(m.role) && typeof m.content === "string")
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_CONTENT),
    }));
}

export function upstreamHeaders(provider, key) {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(provider.extraHeaders || {}),
  };
}

export function normalizeUiContext(raw) {
  if (!raw || typeof raw !== "object") return null;
  const src = raw;
  const out = {};
  const str = (key, max) => {
    if (src[key] == null) return;
    const v = String(src[key]).trim();
    if (v) out[key] = v.slice(0, max);
  };
  str("client", 40);
  str("path", 300);
  str("view", 40);
  str("classId", 120);
  str("className", 160);
  str("period", 8);
  str("noteId", 120);
  str("noteTitle", 200);
  str("noteSubject", 160);
  str("noteText", 1500);
  return Object.keys(out).length ? out : null;
}

export function formatUiContextBlock(ui) {
  if (!ui) return "";
  const lines = ["Open screen (authoritative for this turn):"];
  const view = String(ui.view || "").toLowerCase();
  const client = String(ui.client || "unknown");
  lines.push(`- client: ${client}`);
  if (ui.path) lines.push(`- path: ${ui.path}`);
  if (view === "home") {
    lines.push("- Viewing Home (TODO, day schedule, Notes).");
  } else if (view === "class") {
    lines.push(
      `- Viewing CLASS: ${ui.className || ui.classId || "?"}` +
        (ui.period ? ` (period ${ui.period})` : "") +
        (ui.classId ? ` [id ${ui.classId}]` : "")
    );
    lines.push("- Prefer this class for creates and edits unless they name another.");
  } else if (view === "note") {
    lines.push(
      `- Viewing NOTE: ${ui.noteTitle || ui.noteId || "?"}` +
        (ui.noteSubject ? ` [${ui.noteSubject}]` : "") +
        (ui.noteId ? ` [id ${ui.noteId}]` : "")
    );
    if (ui.classId || ui.className) {
      const klass = [ui.className, ui.classId ? `[id ${ui.classId}]` : ""].filter(Boolean).join(" ");
      lines.push(`- Note class: ${klass}`);
    }
    if (ui.noteText) lines.push(`- Note text:\n${ui.noteText}`);
    lines.push("- Prefer this note for edits or delete unless they name another.");
  } else if (view) {
    lines.push(`- Viewing ${view}.`);
  }
  return lines.join("\n");
}

export function systemPromptWithSnapshot(snapshot = "") {
  const extra = String(snapshot || "").trim();
  return extra ? `${SYSTEM_PROMPT}\n\nLive student snapshot:\n${extra}` : SYSTEM_PROMPT;
}

export function upstreamBody(provider, messages, snapshot = "", extras = {}) {
  return {
    model: provider.model,
    stream: extras.stream !== false,
    messages: [{ role: "system", content: systemPromptWithSnapshot(snapshot) }, ...messages],
    ...(extras.tools ? { tools: extras.tools, tool_choice: extras.toolChoice || "auto" } : {}),
    ...(provider.extraBody || {}),
  };
}

export function extractToolCalls(json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice) return [];
  const src = choice.delta || choice.message || {};
  const raw = src.tool_calls || src.toolCalls;
  return Array.isArray(raw) ? raw : [];
}

export function mergeToolCallDeltas(acc, deltas) {
  const next = acc.slice();
  for (const part of deltas || []) {
    const index = Number.isInteger(part.index) ? part.index : next.length ? next.length - 1 : 0;
    while (next.length <= index) {
      next.push({ id: "", type: "function", function: { name: "", arguments: "" } });
    }
    const row = next[index];
    if (part.id) row.id = part.id;
    if (part.type) row.type = part.type;
    const fn = part.function || {};
    if (fn.name) row.function.name += fn.name;
    if (fn.arguments) row.function.arguments += fn.arguments;
  }
  return next;
}

export function finishedToolCalls(calls) {
  return (calls || []).filter((c) => c?.function?.name);
}

function groqBodyHint(text) {
  const raw = String(text || "");
  try {
    const json = JSON.parse(raw);
    const err = json && typeof json === "object" ? json.error || json : null;
    if (err && typeof err === "object") {
      return String(err.message || err.code || raw);
    }
  } catch {
    /* leftover was not JSON */
  }
  return raw;
}

export function upstreamErrorCode(status, text) {
  const hint = groqBodyHint(text).toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|incorrect api key|invalid_api_key|unauthorized/.test(hint)
  ) {
    return "key_rejected";
  }
  if (isContextOverflow(status, text)) return "context";
  if (
    status === 429 ||
    /rate limit|rate_limit|too many requests|tokens per\s*(min|minute|day)|requests per\s*(min|minute|day)|\btpm\b|\brpm\b|\brpd\b|\btpd\b/.test(
      hint
    )
  ) {
    const window = parseLimitWindow(text);
    if (window === "tpm" || window === "rpm" || (status === 429 && window !== "rpd" && window !== "tpd")) {
      return "key_paused";
    }
    return "key_limited";
  }
  return "upstream";
}

function groqFixSteps() {
  return [
    "1. Open [console.groq.com/keys](https://console.groq.com/keys).",
    "2. Tap Create API Key. Copy the `gsk_` value now. Groq shows it only once.",
    "3. Gear, Chat key, paste, Save key. Chat key must say Groq.",
    "4. Ask again here. Do not paste the key in this box.",
    "Full click-by-click is on [epsynapse.com/groq](/groq).",
  ].join("\n");
}

export function explainUpstreamError(status, text, extras = {}) {
  const tried = Number(extras.attempts || extras.keyCount || 1);
  const many = tried > 1;
  const source = String(extras.source || "");
  const provider = String(extras.provider || "groq");
  const code = upstreamErrorCode(status, text);
  if (code === "context") {
    return "This chat is too long for the model. Start a new chat, or ask something shorter.";
  }
  if (code === "key_paused") {
    return provider === "groq"
      ? [
          "Groq paused the key for a few seconds. The last reply used a burst of tokens, not the daily chat cap.",
          "Ask again. If it keeps pausing, wait a minute.",
        ].join("\n")
      : "The model host paused this key for a few seconds. Ask again.";
  }
  if (provider === "groq" && code === "key_rejected") {
    const head = many
      ? "Every saved Groq key was rejected."
      : "That Groq key was rejected.";
    return [
      `${head} Groq deleted it, or the copy was short.`,
      "Create a new key, then Save key. That is the usual fix when chat dies and a fresh gsk_ brings it back.",
      "",
      groqFixSteps(),
    ].join("\n");
  }
  if (provider === "groq" && code === "key_limited") {
    if (source === "demo") {
      return [
        "The shared table key hit Groq's free limit.",
        "Make your own free key so you are not sharing that quota.",
        "",
        groqFixSteps(),
      ].join("\n");
    }
    const head = many
      ? "Every saved Groq key hit its free limit."
      : "This Groq account hit its free limit.";
    return [
      `${head} This model is about 30 chats a minute and 1000 a day.`,
      "Limits sit on the Groq login. A second key on the same Groq account does not reset a daily cap.",
      "Wait, add a key from a different Groq login, or switch Model to Gemini in Settings.",
      "If a new key on the same login fixed it, the old one was rejected, not limited. Save that new key.",
      "",
      groqFixSteps(),
    ].join("\n");
  }
  if (code === "key_rejected") {
    return many
      ? "Every saved key was rejected. Check you copied the whole key from the provider dashboard."
      : "That key was rejected. Check you copied the whole key from the provider dashboard.";
  }
  if (code === "key_limited") {
    return many
      ? "Every saved key hit its free limit. Wait a bit, or add another key."
      : "This key hit its free limit. Add another key, wait a bit, or try another provider.";
  }
  const clipped = groqBodyHint(text).replace(/\s+/g, " ").slice(0, 240);
  return clipped || `Provider returned ${status}.`;
}

export function textFromModelField(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textFromModelField).join("");
  if (value && typeof value === "object") {
    return (
      textFromModelField(value.text) ||
      textFromModelField(value.content) ||
      textFromModelField(value.reasoning) ||
      ""
    );
  }
  return "";
}

export function extractChatDelta(json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice) return { content: "", reasoning: "" };
  const src = choice.delta || choice.message || {};
  return {
    content: textFromModelField(src.content),
    reasoning:
      textFromModelField(src.reasoning) || textFromModelField(src.reasoning_content),
  };
}

export function consumeSse(buffer, onEvent) {
  const parts = String(buffer || "").split("\n");
  const rest = parts.pop();
  let event = "";
  for (const raw of parts) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("data:")) {
      const chunk = line.slice(5).trim();
      if (chunk.startsWith("{") || chunk === "[DONE]") {
        if (event) onEvent(event);
        event = "";
        onEvent(chunk);
      } else {
        event += chunk;
      }
    } else if (line === "") {
      if (event) onEvent(event);
      event = "";
    }
  }
  return (event ? `data: ${event}\n` : "") + rest;
}
