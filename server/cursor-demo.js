/**
 * One Google account can use the Cursor SDK for chat instead of a pasted key.
 * Default is the hackathon demo login. Override with CURSOR_DEMO_EMAIL.
 */

const DEFAULT_EMAILS = ["yanylevin@gmail.com"];

export function cursorDemoEmails() {
  const raw = String(process.env.CURSOR_DEMO_EMAIL || "").trim();
  const list = (raw || DEFAULT_EMAILS.join(","))
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
