/**
 * Student personal-agent proxy.
 * Students paste their own free key. It lives on the Google account.
 * Optional DEMO_GROQ_KEY covers the table if nobody has pasted one yet.
 */

export const SYSTEM_PROMPT = [
  "You are the EPSynapse personal agent for Eastside Prep students.",
  "Be direct and useful. Skip filler.",
  "Help with school life: classes, homework planning, LPC, EBC, clubs, college-counseling questions they can take to an adult.",
  "You can change the student's dashboard with tools: add/update/delete notes, add/update/check/uncheck/delete todos, add or replace class files including standalone HTML, delete class files, and rename classes.",
  "When they ask you to do one of those things, call the tool. Do not tell them to tap a button instead.",
  "If a live student snapshot is attached, use it. Do not invent courses, due dates, grades, files, or emails that are not in the snapshot or a tool result.",
  "If an open screen is attached, that class or note is the default edit target unless they name something else. Skip open_page when they are already on that page.",
  "After a create, call open_page so the site or app lands on that class or note.",
  "If they want mail sent, tell them to use the Mail panel Send button. You cannot send from chat.",
  "If there is no snapshot, say you do not have live school data yet.",
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

export function publicAgentConfig() {
  return {
    demo: { groq: Boolean(process.env.DEMO_GROQ_KEY) },
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

export function resolveApiKey(req, providerId, student) {
  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (bearer) return { key: bearer, source: "student" };
  const stored = String(student?.modelKey || "").trim();
  if (stored) return { key: stored, source: "account" };
  if (providerId === "groq" && process.env.DEMO_GROQ_KEY) {
    return { key: process.env.DEMO_GROQ_KEY, source: "demo" };
  }
  return { key: "", source: "none" };
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
    lines.push("- Viewing Home (TODO, Classes, Grades, Notes).");
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
  } else if (view === "grades") {
    lines.push("- Viewing Grades.");
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

export function explainUpstreamError(status, text) {
  if (status === 401 || status === 403) {
    return "That key was rejected. Check you copied the whole key from the provider dashboard.";
  }
  if (status === 429) {
    return "This key hit its free limit. Wait a bit, or try another provider.";
  }
  const clipped = String(text || "").replace(/\s+/g, " ").slice(0, 240);
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
