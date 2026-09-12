/**
 * Mac Studio demo path: local OneDrive folder, Outlook session file, optional Teams module.
 * Only active when STUDIO_DEMO_EMAIL matches the signed-in Google account on a Mac Studio.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const TOKEN_SKEW_S = 90;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const WRITE_FOLDER = "EPSynapse";

let macStudioCache = null;

function b64urlJson(part) {
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function jwtClaims(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  const claims = b64urlJson(part);
  return claims && typeof claims === "object" ? claims : {};
}

function jwtExp(token) {
  const exp = Number(jwtClaims(token).exp);
  return Number.isFinite(exp) ? exp : 0;
}

function isNotesToken(token) {
  return /Notes\.(Read|ReadWrite|Create)/i.test(String(jwtClaims(token).scp || ""));
}

export function isMacStudio() {
  if (macStudioCache !== null) return macStudioCache;
  let name = String(process.env.HOSTNAME || hostname() || "").trim();
  if (!/mac[- ]studio/i.test(name)) {
    try {
      name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
    } catch {
      name = "";
    }
  }
  macStudioCache = /mac[- ]studio/i.test(name);
  return macStudioCache;
}

export function demoEmails() {
  const raw = String(process.env.STUDIO_DEMO_EMAIL || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isStudioDemoStudent(student) {
  if (!isMacStudio()) return false;
  const email = String(student?.email || "")
    .trim()
    .toLowerCase();
  if (!email) return false;
  const allowed = demoEmails();
  return allowed.length > 0 && allowed.includes(email);
}

export function onedriveRoot() {
  const env = String(process.env.STUDIO_ONEDRIVE_DIR || "").trim();
  if (env && existsSync(env)) return resolve(env);
  const classic = join(homedir(), "OneDrive - Eastside Preparatory School");
  if (existsSync(classic)) return resolve(classic);
  const cloud = join(homedir(), "Library/CloudStorage/OneDrive-EastsidePreparatorySchool");
  if (existsSync(cloud)) return resolve(cloud);
  return env ? resolve(env) : "";
}

export function mailSessionPath() {
  const direct = String(process.env.STUDIO_MAIL_SESSION || "").trim();
  if (direct) return resolve(direct);
  const dir = String(process.env.STUDIO_MAIL_DIR || "").trim();
  if (dir) return join(resolve(dir), "session.json");
  return "";
}

export function teamsModulePath() {
  return String(process.env.STUDIO_TEAMS_MODULE || "").trim();
}

export function mailModulePath() {
  return String(process.env.STUDIO_MAIL_MODULE || "").trim();
}

export function onenoteModulePath() {
  return String(process.env.STUDIO_ONENOTE_MODULE || "").trim();
}

export function onenoteSessionPath() {
  const direct = String(process.env.STUDIO_ONENOTE_SESSION || "").trim();
  if (direct) return resolve(direct);
  const dir = String(process.env.STUDIO_ONENOTE_DIR || "").trim();
  if (dir) return join(resolve(dir), "session.json");
  return "";
}

function assertUnderRoot(root, target) {
  const base = resolve(root);
  const full = resolve(target);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error("path outside OneDrive root");
  }
  return full;
}

async function loadModule(path, cacheHolder) {
  const modPath = String(path || "").trim();
  if (!modPath || !existsSync(modPath)) return null;
  if (!cacheHolder.promise) {
    const url = modPath.startsWith("file:") ? modPath : pathToFileURL(resolve(modPath)).href;
    cacheHolder.promise = import(url).catch(() => null);
  }
  return cacheHolder.promise;
}

const teamsMod = { promise: null };
const mailMod = { promise: null };
const onenoteMod = { promise: null };

async function loadTeamsModule() {
  return loadModule(teamsModulePath(), teamsMod);
}

async function loadMailModule() {
  return loadModule(mailModulePath(), mailMod);
}

async function loadOnenoteModule() {
  return loadModule(onenoteModulePath(), onenoteMod);
}

export function studioFlags(student) {
  if (!isStudioDemoStudent(student)) {
    return { onedrive: false, outlook: false, teams: false, onenote: false };
  }
  const root = onedriveRoot();
  const onedrive = Boolean(root && existsSync(root));
  const mail = mailSessionPath();
  const mailModFile = mailModulePath();
  const outlook = Boolean((mail && existsSync(mail)) || (mailModFile && existsSync(mailModFile)));
  const teamsModFile = teamsModulePath();
  const teams = Boolean(teamsModFile && existsSync(teamsModFile));
  const notes = onenoteSessionPath();
  const notesModFile = onenoteModulePath();
  const onenote = Boolean((notes && existsSync(notes)) || (notesModFile && existsSync(notesModFile)));
  return { onedrive, outlook, teams, onenote };
}

async function walkFiles(root, { depth = 3, cap = 80, q = "" } = {}) {
  const needle = String(q || "")
    .trim()
    .toLowerCase();
  const out = [];

  async function walk(dir, level) {
    if (out.length >= cap || level > depth) return;
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= cap) break;
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full, level + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (needle && !name.toLowerCase().includes(needle)) continue;
      const rel = relative(root, full).split(sep).join("/");
      out.push({
        id: `studio:${rel}`,
        name,
        path: rel,
        size: st.size,
        lastModified: st.mtime.toISOString(),
        source: "studio",
      });
    }
  }

  await walk(root, 0);
  return out;
}

export async function listStudioFiles({ q, limit } = {}) {
  const root = onedriveRoot();
  if (!root || !existsSync(root)) return [];
  const cap = Math.min(80, Math.max(1, Number(limit) || 80));
  try {
    return await walkFiles(root, { depth: 3, cap, q });
  } catch {
    return [];
  }
}

export async function readStudioFile(idOrPath) {
  const root = onedriveRoot();
  if (!root) throw new Error("OneDrive folder not configured");
  let rel = String(idOrPath || "").trim();
  if (rel.startsWith("studio:")) rel = rel.slice("studio:".length);
  rel = rel.replace(/^\/+/, "");
  const full = assertUnderRoot(root, join(root, rel));
  const st = await stat(full);
  if (!st.isFile()) throw new Error("not a file");
  const buffer = await readFile(full);
  const name = full.split(sep).pop() || "file";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  const types = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
  };
  const contentType = types[ext] || "application/octet-stream";
  return { name, buffer, contentType, path: relative(root, full).split(sep).join("/") };
}

export async function writeStudioFile({ name, content, contentType, folder } = {}) {
  const root = onedriveRoot();
  if (!root) throw new Error("OneDrive folder not configured");
  const fileName = String(name || "upload.bin").trim();
  if (!fileName || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("invalid file name");
  }
  const sub = String(folder || WRITE_FOLDER).trim() || WRITE_FOLDER;
  const dir = assertUnderRoot(root, join(root, sub));
  await mkdir(dir, { recursive: true });
  const full = join(dir, fileName);
  const body =
    content instanceof Buffer ? content : Buffer.from(String(content ?? ""), "utf8");
  await writeFile(full, body);
  const st = await stat(full);
  const rel = relative(root, full).split(sep).join("/");
  return {
    id: `studio:${rel}`,
    name: fileName,
    path: rel,
    size: st.size,
    lastModified: st.mtime.toISOString(),
    contentType: String(contentType || "application/octet-stream"),
    source: "studio",
  };
}

async function readMailSessionToken() {
  const path = mailSessionPath();
  if (!path || !existsSync(path)) return "";
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    const token = String(raw?.token || raw?.accessToken || "").trim();
    if (!token) return "";
    const exp = jwtExp(token);
    if (exp && exp * 1000 <= Date.now() + TOKEN_SKEW_S * 1000) return "";
    return token;
  } catch {
    return "";
  }
}

export async function studioOutlookToken() {
  const live = await readMailSessionToken();
  if (live) return live;
  const mod = await loadMailModule();
  if (mod && typeof mod.fetchSchoolMessages === "function") {
    try {
      await mod.fetchSchoolMessages({ max: 1 });
    } catch {
      return "";
    }
    return readMailSessionToken();
  }
  return "";
}

async function readOnenoteSessionToken() {
  const path = onenoteSessionPath();
  if (!path || !existsSync(path)) return "";
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    const token = String(raw?.token || raw?.accessToken || "").trim();
    if (!token || !isNotesToken(token)) return "";
    const exp = jwtExp(token) || Number(raw.exp) || 0;
    if (exp && exp * 1000 <= Date.now() + TOKEN_SKEW_S * 1000) return "";
    return token;
  } catch {
    return "";
  }
}

export async function studioOnenoteToken() {
  const live = await readOnenoteSessionToken();
  if (live) return live;
  const mod = await loadOnenoteModule();
  if (mod && typeof mod.runSchoolOnenote === "function") {
    const session = onenoteSessionPath();
    const root = session ? dirname(session) : undefined;
    try {
      await mod.runSchoolOnenote(["notebooks"], root ? { root } : {});
    } catch {
      return "";
    }
    return readOnenoteSessionToken();
  }
  return "";
}

export async function studioTeamsAvailable() {
  const modPath = teamsModulePath();
  return Boolean(modPath && existsSync(modPath));
}

function chatMatches(msg, chat) {
  const needle = String(chat || "").trim().toLowerCase();
  if (!needle) return false;
  const id = String(msg?.chatId || msg?.id || "").trim();
  const name = String(msg?.chat || msg?.name || "").trim().toLowerCase();
  if (id && (id === needle || id.toLowerCase() === needle)) return true;
  return name && name === needle;
}

export async function listStudioChats({ limit } = {}) {
  const mod = await loadTeamsModule();
  if (!mod) return [];
  const top = Math.min(50, Math.max(1, Number(limit) || 12));
  try {
    if (typeof mod.fetchSchoolTeams === "function") {
      const data = await mod.fetchSchoolTeams({ max: top });
      return (Array.isArray(data?.chats) ? data.chats : [])
        .slice(0, top)
        .map((c) => ({
          id: String(c.id || ""),
          name: String(c.name || ""),
          chatType: String(c.chatType || ""),
          updated: String(c.updated || ""),
          source: "studio",
        }));
    }
    if (typeof mod.listChats === "function" && typeof mod.resolveSession === "function") {
      const session = await mod.resolveSession({});
      const rows = await mod.listChats(session, { limit: top });
      return rows.slice(0, top).map((c) => ({
        id: String(c.id || ""),
        name: String(c.name || ""),
        chatType: String(c.chatType || ""),
        updated: String(c.updated || ""),
        source: "studio",
      }));
    }
  } catch {
    return [];
  }
  return [];
}

export async function listStudioChatMessages(chat, { limit } = {}) {
  const mod = await loadTeamsModule();
  if (!mod) return [];
  const top = Math.min(50, Math.max(1, Number(limit) || 20));
  try {
    if (typeof mod.fetchSchoolTeams === "function") {
      const data = await mod.fetchSchoolTeams({ max: Math.max(top * 3, 24) });
      const rows = Array.isArray(data?.messages) ? data.messages : [];
      return rows
        .filter((m) => chatMatches(m, chat))
        .slice(0, top)
        .map((m) => ({
          id: String(m.id || ""),
          chatId: String(m.chatId || ""),
          from: String(m.from || ""),
          text: String(m.text || ""),
          at: String(m.at || ""),
          source: "studio",
        }));
    }
    if (typeof mod.listChatMessages === "function" && typeof mod.resolveSession === "function") {
      const session = await mod.resolveSession({});
      const chatId = String(chat || "").trim();
      const rows = await mod.listChatMessages(session, chatId, { limit: top });
      return rows.slice(0, top).map((m) => ({
        id: String(m.id || ""),
        chatId: String(m.chatId || chatId),
        from: String(m.from || ""),
        text: String(m.text || ""),
        at: String(m.at || ""),
        source: "studio",
      }));
    }
  } catch {
    return [];
  }
  return [];
}

export async function sendStudioChat({ chat, text } = {}) {
  const mod = await loadTeamsModule();
  if (!mod) return { ok: false, error: "Teams module not configured" };
  try {
    if (typeof mod.sendTeamsMessage === "function") {
      return mod.sendTeamsMessage({ chat, text });
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "send failed" };
  }
  return { ok: false, error: "send not available" };
}
