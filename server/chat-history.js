/**
 * Past chats, one JSON file per thread under server/data/chats/<owner>/.
 * Owner is the signed-in Google student. Hidden from git via server/data/.
 */

import { randomUUID } from "node:crypto";
import { sanitizeMessages } from "./agent.js";
import { deleteDoc, getDoc, listIds, putDoc } from "./store.js";
import { googleFileId as studentFileId } from "./students.js";

const MAX_CHATS = 80;
const MAX_TITLE = 72;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHATS = "chats";

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

/** store.js collection for one owner: chats/<ownerId> -> data/chats/<ownerId>/<chatId>.json */
function chatsCollection(ownerId) {
  const id = String(ownerId || "").trim();
  if (!id || id === "." || id === ".." || /[\\/\0]/.test(id)) {
    throw new Error("Invalid chat owner.");
  }
  return `${CHATS}/${id}`;
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

export function chatHistoryIsUnread(updated, lastRead) {
  const u = Date.parse(String(updated || ""));
  const r = Date.parse(String(lastRead || ""));
  if (!Number.isFinite(u) || !Number.isFinite(r)) return false;
  return u > r;
}

function lastReadOnPersist(existing, now) {
  if (!existing) return now;
  const kept = String(existing.lastRead || "").trim();
  if (kept) return kept;
  return String(existing.updated || now);
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
    unread: chatHistoryIsUnread(updated, lastRead),
  };
}

async function readChatFile(ownerId, chatId) {
  return getDoc(chatsCollection(ownerId), chatId);
}

async function writeChatFile(ownerId, chat) {
  await putDoc(chatsCollection(ownerId), chat.sessionId, chat);
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
    lastRead: lastReadOnPersist(existing, now),
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
  const collection = chatsCollection(ownerId);
  await Promise.all(
    extra.map((row) => deleteDoc(collection, row.sessionId).catch(() => {}))
  );
}

async function listChatFiles(ownerId) {
  const ids = await listIds(chatsCollection(ownerId));
  const rows = [];
  for (const id of ids) {
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

/** Account deletion: every saved chat for one owner. Idempotent. */
export async function deleteOwnerData(ownerId) {
  const collection = chatsCollection(ownerId);
  let chats = 0;
  for (const id of await listIds(collection)) {
    if (await deleteDoc(collection, id).catch(() => false)) chats += 1;
  }
  return { chats };
}

export async function markChatRead(ownerId, sessionId) {
  const id = assertChatId(sessionId);
  const chat = await readChatFile(ownerId, id);
  if (!chat) return { ok: true };
  chat.lastRead = new Date().toISOString();
  await writeChatFile(ownerId, chat);
  return { ok: true };
}
