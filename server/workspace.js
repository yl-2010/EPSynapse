/**
 * Student-owned todos, class files, and class name overrides.
 * Lives under server/data/workspace/{ownerId}/. Hidden from git with the rest of data/.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_PREFIX = "local:";
const CLASS_FILE_PREFIX = "class:";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HTML_PREVIEW = 200 * 1024;
const META_NAME = "_meta.json";
const TAGS = new Set(["CW", "HW", "QA", "MA"]);

function rootDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "data", "workspace");
}

function assertOwner(ownerId) {
  const id = String(ownerId || "").trim();
  if (!id || id.includes("..") || /[\\/]/.test(id)) {
    throw new Error("Invalid workspace owner.");
  }
  return id;
}

function ownerDir(ownerId) {
  const id = assertOwner(ownerId);
  const root = resolve(rootDir());
  const full = resolve(root, id);
  if (full !== join(root, id) && !full.startsWith(root + sep)) {
    throw new Error("Invalid workspace owner.");
  }
  return full;
}

function safeClassKey(raw) {
  const key = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!key || key === "." || key === "..") {
    const err = new Error("Unknown class.");
    err.status = 404;
    throw err;
  }
  return key;
}

export function safeFileName(name) {
  const n = String(name || "").trim();
  if (!n) throw Object.assign(new Error("file name required"), { status: 400 });
  if (/[/\\]/.test(n) || n.includes("\0")) {
    throw Object.assign(new Error("file name cannot contain slashes"), { status: 400 });
  }
  if (n === "." || n === ".." || n === META_NAME) {
    throw Object.assign(new Error("invalid file name"), { status: 400 });
  }
  if (n.length > 180) throw Object.assign(new Error("file name is too long"), { status: 400 });
  return n;
}

async function writeJsonAtomic(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function readJson(filePath) {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function metaPath(ownerId) {
  return join(ownerDir(ownerId), "meta.json");
}

function todosDir(ownerId) {
  return join(ownerDir(ownerId), "todos");
}

function todoPath(ownerId, id) {
  return join(todosDir(ownerId), `${id}.json`);
}

function classFilesDir(ownerId, classId) {
  return join(ownerDir(ownerId), "files", safeClassKey(classId));
}

export function isLocalTodoId(raw) {
  const id = String(raw || "").trim();
  if (id.startsWith(LOCAL_PREFIX)) return ID_RE.test(id.slice(LOCAL_PREFIX.length));
  return ID_RE.test(id);
}

export function bareTodoId(raw) {
  const id = String(raw || "").trim();
  return id.startsWith(LOCAL_PREFIX) ? id.slice(LOCAL_PREFIX.length) : id;
}

export function publicTodoId(id) {
  const bare = bareTodoId(id);
  return `${LOCAL_PREFIX}${bare}`;
}

function emptyMeta() {
  return { classAliases: {}, hiddenTodoIds: [], canvasTodoDone: {} };
}

function cleanCanvasTodoDone(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = String(key || "").trim();
    if (id) out[id] = Boolean(value);
  }
  return out;
}

export async function loadWorkspaceMeta(ownerId) {
  const raw = await readJson(metaPath(ownerId));
  const aliases =
    raw?.classAliases && typeof raw.classAliases === "object" && !Array.isArray(raw.classAliases)
      ? raw.classAliases
      : {};
  const hidden = Array.isArray(raw?.hiddenTodoIds)
    ? raw.hiddenTodoIds.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  return { classAliases: aliases, hiddenTodoIds: hidden, canvasTodoDone: cleanCanvasTodoDone(raw?.canvasTodoDone) };
}

async function saveWorkspaceMeta(ownerId, meta) {
  await writeJsonAtomic(metaPath(ownerId), {
    classAliases: meta.classAliases || {},
    hiddenTodoIds: meta.hiddenTodoIds || [],
    canvasTodoDone: cleanCanvasTodoDone(meta.canvasTodoDone),
  });
}

function publicTodo(todo) {
  if (!todo) return null;
  return {
    id: publicTodoId(todo.id),
    canvasId: "",
    canvasLink: String(todo.canvasLink || ""),
    title: String(todo.title || "Todo"),
    courseName: String(todo.courseName || ""),
    courseId: String(todo.classId || ""),
    classId: String(todo.classId || ""),
    due: String(todo.due || ""),
    tag: TAGS.has(String(todo.tag || "").toUpperCase()) ? String(todo.tag).toUpperCase() : "HW",
    done: Boolean(todo.done),
    plannerOverrideId: "",
    plannableType: "local",
    description: String(todo.description || ""),
    createdAt: String(todo.createdAt || ""),
    completedAt: String(todo.completedAt || ""),
    source: "local",
  };
}

export async function listTodos(ownerId) {
  const dir = todosDir(ownerId);
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
    const todo = await readJson(join(dir, name));
    if (todo?.id) rows.push(publicTodo(todo));
  }
  rows.sort((a, b) => String(a.due || a.createdAt || "").localeCompare(String(b.due || b.createdAt || "")));
  return rows;
}

export async function loadTodo(ownerId, rawId) {
  const id = bareTodoId(rawId);
  if (!ID_RE.test(id)) {
    const err = new Error("Unknown todo.");
    err.status = 404;
    throw err;
  }
  const todo = await readJson(todoPath(ownerId, id));
  if (!todo) {
    const err = new Error("Unknown todo.");
    err.status = 404;
    throw err;
  }
  return todo;
}

function dueFromInput(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T12:00:00.000Z`;
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text.slice(0, 40);
  return d.toISOString();
}

export async function createTodo(ownerId, input = {}) {
  const title = String(input.title || input.name || "").trim();
  if (!title) {
    const err = new Error("Give the todo a title.");
    err.status = 400;
    throw err;
  }
  const now = new Date().toISOString();
  const tag = String(input.tag || "HW").toUpperCase();
  const todo = {
    id: randomUUID(),
    title: title.slice(0, 200),
    classId: String(input.classId || input.courseId || "").trim(),
    courseName: String(input.courseName || input.className || "").trim(),
    due: dueFromInput(input.due || input.dueDate),
    tag: TAGS.has(tag) ? tag : "HW",
    done: Boolean(input.done),
    description: String(input.description || "").slice(0, 8000),
    canvasLink: String(input.canvasLink || "").trim(),
    createdAt: now,
    completedAt: input.done ? now : "",
  };
  await mkdir(todosDir(ownerId), { recursive: true });
  await writeJsonAtomic(todoPath(ownerId, todo.id), todo);
  return publicTodo(todo);
}

export async function patchTodo(ownerId, rawId, input = {}) {
  const todo = await loadTodo(ownerId, rawId);
  if (input.title != null || input.name != null) {
    const title = String(input.title || input.name || "").trim();
    if (!title) {
      const err = new Error("Give the todo a title.");
      err.status = 400;
      throw err;
    }
    todo.title = title.slice(0, 200);
  }
  if (input.classId != null || input.courseId != null) {
    todo.classId = String(input.classId || input.courseId || "").trim();
  }
  if (input.courseName != null || input.className != null) {
    todo.courseName = String(input.courseName || input.className || "").trim();
  }
  if (input.due != null || input.dueDate != null) {
    todo.due = dueFromInput(input.due || input.dueDate);
  }
  if (input.tag != null) {
    const tag = String(input.tag || "").toUpperCase();
    if (TAGS.has(tag)) todo.tag = tag;
  }
  if (input.description != null) {
    todo.description = String(input.description || "").slice(0, 8000);
  }
  if (input.canvasLink != null) {
    todo.canvasLink = String(input.canvasLink || "").trim();
  }
  if (input.done != null) {
    const done = Boolean(input.done);
    todo.done = done;
    todo.completedAt = done ? new Date().toISOString() : "";
  }
  await writeJsonAtomic(todoPath(ownerId, todo.id), todo);
  return publicTodo(todo);
}

export async function deleteTodo(ownerId, rawId) {
  const todo = await loadTodo(ownerId, rawId);
  await unlink(todoPath(ownerId, todo.id)).catch((err) => {
    if (err && err.code !== "ENOENT") throw err;
  });
  return { ok: true, id: publicTodoId(todo.id) };
}

export async function hideCanvasTodo(ownerId, canvasId) {
  const id = String(canvasId || "").trim();
  if (!id) {
    const err = new Error("Missing todo id.");
    err.status = 400;
    throw err;
  }
  const meta = await loadWorkspaceMeta(ownerId);
  if (!meta.hiddenTodoIds.includes(id)) meta.hiddenTodoIds.push(id);
  await saveWorkspaceMeta(ownerId, meta);
  return { ok: true, id };
}

export async function setCanvasTodoDone(ownerId, canvasId, done, extra = {}) {
  const id = String(canvasId || extra.canvasId || "").trim();
  if (!id) {
    const err = new Error("Missing todo id.");
    err.status = 400;
    throw err;
  }
  const meta = await loadWorkspaceMeta(ownerId);
  meta.canvasTodoDone[id] = Boolean(done);
  await saveWorkspaceMeta(ownerId, meta);
  return {
    id,
    canvasId: id,
    done: Boolean(done),
    plannerOverrideId: String(extra.plannerOverrideId || "").trim(),
    plannableType: String(extra.plannableType || "assignment").trim() || "assignment",
  };
}

function overlayCanvasDone(row, doneMap) {
  if (!row || !doneMap) return row;
  const id = String(row.id || "");
  const canvasId = String(row.canvasId || "");
  if (id && Object.prototype.hasOwnProperty.call(doneMap, id)) {
    return { ...row, done: Boolean(doneMap[id]) };
  }
  if (canvasId && canvasId !== id && Object.prototype.hasOwnProperty.call(doneMap, canvasId)) {
    return { ...row, done: Boolean(doneMap[canvasId]) };
  }
  return row;
}

export function mergeAssignments(canvasRows, localRows, hiddenIds = [], canvasTodoDone = {}) {
  const hidden = new Set((hiddenIds || []).map((x) => String(x)));
  const doneMap = cleanCanvasTodoDone(canvasTodoDone);
  const canvas = (canvasRows || [])
    .filter((row) => {
      const id = String(row?.id || row?.canvasId || "");
      return id && !hidden.has(id);
    })
    .map((row) => overlayCanvasDone(row, doneMap));
  const locals = localRows || [];
  return [...locals, ...canvas];
}

export function applyClassAliases(rows, aliases) {
  const map = aliases && typeof aliases === "object" ? aliases : {};
  if (!rows?.length || !Object.keys(map).length) return rows || [];
  return rows.map((row) => {
    if (!row) return row;
    const byId = map[String(row.id || "")];
    const byName = map[String(row.name || "").trim().toLowerCase()];
    const next = String(byId || byName || "").trim();
    if (!next || next === row.name) return row;
    return { ...row, name: next, originalName: row.originalName || row.name };
  });
}

export async function renameClass(ownerId, classId, name, originalName = "") {
  const id = String(classId || "").trim();
  const next = String(name || "").trim();
  if (!id) {
    const err = new Error("Missing class id.");
    err.status = 400;
    throw err;
  }
  if (!next) {
    const err = new Error("Give the class a name.");
    err.status = 400;
    throw err;
  }
  const meta = await loadWorkspaceMeta(ownerId);
  const label = next.slice(0, 120);
  meta.classAliases[id] = label;
  const prior = String(originalName || "").trim().toLowerCase();
  if (prior) meta.classAliases[prior] = label;
  await saveWorkspaceMeta(ownerId, meta);
  return { id, name: label };
}

function guessContentType(name, fallback) {
  const given = String(fallback || "").trim();
  if (given) return given;
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function toBuffer(content, encoding) {
  if (content === undefined || content === null) {
    throw Object.assign(new Error("file content required"), { status: 400 });
  }
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (String(encoding || "").toLowerCase() === "base64") {
    return Buffer.from(String(content), "base64");
  }
  return Buffer.from(String(content), "utf8");
}

function isTextType(contentType, name) {
  const type = String(contentType || "").toLowerCase();
  const lower = String(name || "").toLowerCase();
  return (
    type.startsWith("text/") ||
    type.includes("json") ||
    type.includes("javascript") ||
    /\.(html?|md|txt|css|js|json|xml|svg)$/i.test(lower)
  );
}

async function readClassFileMeta(dir) {
  const raw = await readJson(join(dir, META_NAME));
  return raw && typeof raw === "object" ? raw : {};
}

async function writeClassFileMeta(dir, meta) {
  await writeFile(join(dir, META_NAME), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function classFileId(classId, name) {
  return `${CLASS_FILE_PREFIX}${safeClassKey(classId)}:${name}`;
}

export function parseClassFileId(raw) {
  const id = String(raw || "").trim();
  if (!id.startsWith(CLASS_FILE_PREFIX)) return null;
  const rest = id.slice(CLASS_FILE_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon < 1) return null;
  return { classId: rest.slice(0, colon), name: rest.slice(colon + 1) };
}

function publicClassFile(classId, name, size, lastModified, contentType, text) {
  const row = {
    id: classFileId(classId, name),
    name,
    size: Number(size) || 0,
    lastModified: String(lastModified || ""),
    folder: false,
    webUrl: "",
    downloadUrl: "",
    source: "class",
    classId: String(classId || ""),
    contentType: contentType || "application/octet-stream",
  };
  if (text != null) row.text = text;
  return row;
}

export async function listClassFiles(ownerId, classId, { includeText = false } = {}) {
  const key = safeClassKey(classId);
  const dir = classFilesDir(ownerId, key);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const meta = await readClassFileMeta(dir);
  const out = [];
  for (const name of names) {
    if (name === META_NAME || name.startsWith(".")) continue;
    let info;
    try {
      info = await stat(join(dir, name));
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    const row = meta[name] && typeof meta[name] === "object" ? meta[name] : {};
    const contentType = String(row.contentType || guessContentType(name, ""));
    let text;
    if (includeText && isTextType(contentType, name) && info.size <= MAX_HTML_PREVIEW) {
      try {
        text = await readFile(join(dir, name), "utf8");
      } catch {
        text = undefined;
      }
    }
    out.push(
      publicClassFile(
        classId,
        name,
        info.size,
        row.lastModified || info.mtime.toISOString(),
        contentType,
        text
      )
    );
  }
  out.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)));
  return out;
}

export async function listAllClassFiles(ownerId, { includeText = false } = {}) {
  const root = join(ownerDir(ownerId), "files");
  let classIds = [];
  try {
    classIds = await readdir(root);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const classId of classIds) {
    if (classId.startsWith(".")) continue;
    out.push(...(await listClassFiles(ownerId, classId, { includeText })));
  }
  return out;
}

export async function writeClassFile(ownerId, classId, { name, content, contentType, encoding } = {}) {
  const key = safeClassKey(classId);
  const safe = safeFileName(name);
  const buf = toBuffer(content, encoding);
  if (buf.length > MAX_FILE_BYTES) {
    throw Object.assign(new Error("File is too large (2MB max)."), { status: 400 });
  }
  const dir = classFilesDir(ownerId, key);
  await mkdir(dir, { recursive: true });
  const type = guessContentType(safe, contentType);
  await writeFile(join(dir, safe), buf);
  const lastModified = new Date().toISOString();
  const meta = await readClassFileMeta(dir);
  meta[safe] = { contentType: type, lastModified };
  await writeClassFileMeta(dir, meta);
  const text = isTextType(type, safe) && buf.length <= MAX_HTML_PREVIEW ? buf.toString("utf8") : undefined;
  return publicClassFile(classId, safe, buf.length, lastModified, type, text);
}

export async function readClassFile(ownerId, classId, name) {
  const key = safeClassKey(classId);
  const safe = safeFileName(name);
  const dir = classFilesDir(ownerId, key);
  let buffer;
  try {
    buffer = await readFile(join(dir, safe));
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw Object.assign(new Error("file not found"), { status: 404 });
    }
    throw err;
  }
  const meta = await readClassFileMeta(dir);
  const contentType = String(meta[safe]?.contentType || guessContentType(safe, ""));
  return { name: safe, classId: key, contentType, buffer };
}

export async function deleteClassFile(ownerId, classId, name) {
  const key = safeClassKey(classId);
  const safe = safeFileName(name);
  const dir = classFilesDir(ownerId, key);
  await unlink(join(dir, safe)).catch((err) => {
    if (err?.code === "ENOENT") {
      throw Object.assign(new Error("file not found"), { status: 404 });
    }
    throw err;
  });
  const meta = await readClassFileMeta(dir);
  delete meta[safe];
  await writeClassFileMeta(dir, meta);
  return { ok: true, id: classFileId(classId, safe) };
}

export async function workspaceSnapshotBits(ownerId) {
  if (!ownerId) return [];
  const bits = [];
  try {
    const todos = await listTodos(ownerId);
    const open = todos.filter((t) => !t.done).slice(0, 12);
    const done = todos.filter((t) => t.done).slice(0, 6);
    if (open.length) {
      bits.push(
        `Local todos: ${open
          .map((t) => `${t.tag} ${t.title}${t.courseName ? ` (${t.courseName})` : ""}${t.due ? ` ${t.due.slice(0, 10)}` : ""}`)
          .join("; ")}`
      );
    }
    if (done.length) {
      bits.push(`Local completed: ${done.map((t) => t.title).join("; ")}`);
    }
  } catch {
    /* ignore */
  }
  try {
    const files = await listAllClassFiles(ownerId);
    if (files.length) {
      bits.push(
        `Class files: ${files
          .slice(0, 16)
          .map((f) => `${f.name} [${f.classId}]`)
          .join("; ")}`
      );
    }
  } catch {
    /* ignore */
  }
  try {
    const meta = await loadWorkspaceMeta(ownerId);
    const seen = new Set();
    const names = [];
    for (const [k, v] of Object.entries(meta.classAliases || {})) {
      if (!k || !v || seen.has(v)) continue;
      seen.add(v);
      names.push(`${k} -> ${v}`);
      if (names.length >= 12) break;
    }
    if (names.length) bits.push(`Class name overrides: ${names.join("; ")}`);
  } catch {
    /* ignore */
  }
  return bits;
}
