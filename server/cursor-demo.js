/**
 * Optional: the Google accounts listed in CURSOR_DEMO_EMAIL use the Cursor SDK for
 * chat instead of their own model key. Off unless that variable is set. No account
 * is special by default; every student brings their own Groq, Gemini, or OpenRouter key.
 */

export function cursorDemoEmails() {
  const raw = String(process.env.CURSOR_DEMO_EMAIL || "").trim();
  if (!raw) return [];
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list;
}

export function isCursorDemoStudent(student) {
  const email = String(student?.email || "")
    .trim()
    .toLowerCase();
  if (!email) return false;
  return cursorDemoEmails().includes(email);
}

export function cursorAgentReady() {
  return Boolean(String(process.env.CURSOR_API_KEY || "").trim());
}

export function usesCursorAgent(student) {
  return isCursorDemoStudent(student) && cursorAgentReady();
}
