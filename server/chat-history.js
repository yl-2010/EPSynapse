/**
 * Past chats, one JSON file per thread under server/data/chats/<owner>/.
 * Owner is the signed-in Google student. Hidden from git via server/data/.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeMessages } from "./agent.js";
import { googleFileId as studentFileId } from "./students.js";

const MAX_CHATS = 80;
const MAX_TITLE = 72;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function chatsRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "data", "chats");
}

export function ownerIdForStudent(student) {
  const sub = String(student?.googleSub || "").trim();
  if (sub) return studentFileId(sub);
  const email = String(student?.email || "").trim().toLowerCase();
  if (email) return `email__${email.replace(/[^a-z0-9._@+-]+/g, "-")}`;
  return "";
}

export function assertChatId(raw) {
  const id = String(raw || "").trim();
  if (!ID_RE.test(id)) {
    const err = new Error("Unknown chat.");
    err.status = 404;
    throw err;
  }
  return id;
}

function ownerDir(ownerId) {
  const root = resolve(chatsRoot());
  const full = resolve(root, ownerId);
  if (full !== join(root, ownerId) && !full.startsWith(root + sep)) {
    throw new Error("Invalid chat owner.");
  }
  return full;
}

function chatPath(ownerId, chatId) {
  const dir = ownerDir(ownerId);
  const full = resolve(dir, `${chatId}.json`);
  if (full !== join(dir, `${chatId}.json`) && !full.startsWith(dir + sep)) {
    throw new Error("Invalid chat id.");
  }
  return full;
}

function titleFromMessages(messages, fallback = "") {
  const given = String(fallback || "").trim();
  if (given) return given.slice(0, MAX_TITLE);
  const first = (messages || []).find((m) => m.role === "user" && String(m.content || "").trim());
  const text = String(first?.content || "").replace(/\s+/g, " ").trim();
  if (!text) return "Chat";
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text;
}

function previewFromMessages(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const text = String(messages[i]?.content || "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 160);
  }
  return "";
}

function publicRow(chat) {
  const updated = String(chat.updated || "");
  const lastRead = String(chat.lastRead || "");
  return {
    sessionId: chat.sessionId,
    title: chat.title || "Chat",
    preview: chat.preview || "",
    started: chat.started || updated,
    updated,
    unread: Boolean(lastRead && updated && lastRead < updated),
  };
}

async function readChatFile(ownerId, chatId) {
  try {
    const raw = await readFile(chatPath(ownerId, chatId), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeChatFile(ownerId, chat) {
  const dir = ownerDir(ownerId);
  await mkdir(dir, { recursive: true });
  const dest = chatPath(ownerId, chat.sessionId);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(chat, null, 2), "utf8");
  await rename(tmp, dest);
}

export async function persistChat({ ownerId, sessionId, messages, title }) {
  const owner = String(ownerId || "").trim();
  if (!owner) {
    const err = new Error("Sign in first.");
    err.status = 401;
    throw err;
  }
  const clean = sanitizeMessages(messages);
  const id = sessionId ? assertChatId(sessionId) : randomUUID();
  const now = new Date().toISOString();
  const existing = await readChatFile(owner, id);
  const chat = {
    sessionId: id,
    title: titleFromMessages(clean, existing?.title || title),
    preview: previewFromMessages(clean),
    started: existing?.started || now,
    updated: now,
    lastRead: now,
    messages: clean,
  };
  await writeChatFile(owner, chat);
  await pruneOldChats(owner);
  return chat;
}

async function pruneOldChats(ownerId) {
  const rows = await listChatFiles(ownerId);
  if (rows.length <= MAX_CHATS) return;
  const extra = rows.slice(MAX_CHATS);
  await Promise.all(
    extra.map((row) => unlink(chatPath(ownerId, row.sessionId)).catch(() => {}))
  );
}

async function listChatFiles(ownerId) {
  const dir = ownerDir(ownerId);
  let names = [];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    const chat = await readChatFile(ownerId, id);
    if (!chat?.sessionId) continue;
    rows.push(chat);
  }
  rows.sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
  return rows;
}

export async function listChats(ownerId) {
  const rows = await listChatFiles(ownerId);
  return rows.map(publicRow);
}

export async function loadChat(ownerId, sessionId) {
  const chat = await readChatFile(ownerId, assertChatId(sessionId));
  if (!chat) {
    const err = new Error("Unknown chat.");
    err.status = 404;
    throw err;
  }
  return {
    ...publicRow(chat),
    messages: Array.isArray(chat.messages) ? chat.messages : [],
  };
}

export async function markChatRead(ownerId, sessionId) {
  const id = assertChatId(sessionId);
  const chat = await readChatFile(ownerId, id);
  if (!chat) return { ok: true };
  chat.lastRead = new Date().toISOString();
  await writeChatFile(ownerId, chat);
  return { ok: true };
}
