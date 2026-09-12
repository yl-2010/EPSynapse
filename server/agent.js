/**
 * Student personal-agent proxy.
 * Students paste their own free key. It lives on the Google account.
 * Optional DEMO_GROQ_KEY covers the table if nobody has pasted one yet.
 */

export const SYSTEM_PROMPT = [
  "You are the EPSynapse personal agent for Eastside Prep students.",
  "Be direct and useful. Skip filler.",
  "Help with school life: classes, homework planning, LPC, EBC, clubs, college-counseling questions they can take to an adult.",
  "If a live student snapshot is attached, use it. Do not invent courses, due dates, files, or emails that are not in the snapshot.",
  "If they want mail sent, tell them to use the Mail panel Send button. You cannot send from chat.",
  "If there is no snapshot, say you do not have live school data yet.",
  "If they ask you to remember something, work only with what is already in this conversation.",
  "Write the bubble in markdown: headings, lists, bold, italics, code, tables. Never HTML tags or markdown images.",
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
  "Do not paste a key in this chat. Open Settings (bottom-left gear) → Chat key, then paste a free Groq key from console.groq.com/keys and save.";

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

export function upstreamBody(provider, messages, snapshot = "") {
  const extra = String(snapshot || "").trim();
  const system = extra
    ? `${SYSTEM_PROMPT}\n\nLive student snapshot:\n${extra}`
    : SYSTEM_PROMPT;
  return {
    model: provider.model,
    stream: true,
    messages: [{ role: "system", content: system }, ...messages],
    ...(provider.extraBody || {}),
  };
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
