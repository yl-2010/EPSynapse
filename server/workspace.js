/**
 * Student-owned todos, class files, and class name overrides.
 * Lives under server/data/workspace/{ownerId}/. Hidden from git with the rest of data/.
 *
 * JSON (meta.json, todos/<id>.json, files/.../_meta.json) goes through store.js.
 * File bytes (files/<classKey>/<name>, files/todos/<todoKey>/<name>) go through blobs.js.
 */

import { randomUUID } from "node:crypto";
import { deleteBlob, getBlob, listBlobs, putBlob } from "./blobs.js";
import { deleteDoc, getDoc, listIds, putDoc } from "./store.js";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_PREFIX = "local:";
const CLASS_FILE_PREFIX = "class:";
const TODO_FILE_PREFIX = "todo:";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_HTML_PREVIEW = 200 * 1024;
const META_NAME = "_meta.json";
const META_DOC = "_meta";
const WORKSPACE = "workspace";
const TAGS = new Set(["CW", "HW", "QA", "MA"]);

function assertOwner(ownerId) {
  const id = String(ownerId || "").trim();
  if (!id || id === "." || id.includes("..") || /[\\/\0]/.test(id)) {
    throw new Error("Invalid workspace owner.");
  }
  return id;
}

/** store.js collection workspace/<ownerId> -> data/workspace/<ownerId>/<doc>.json */
function ownerCollection(ownerId) {
  return `${WORKSPACE}/${assertOwner(ownerId)}`;
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

/** store.js collection workspace/<ownerId>/todos -> data/workspace/<ownerId>/todos/<id>.json */
function todosCollection(ownerId) {
  return `${ownerCollection(ownerId)}/todos`;
}

/**
 * Class files live at blob key workspace/<ownerId>/files/<classKey>/<name>.
 * Their sidecar is doc _meta in collection workspace/<ownerId>/files/<classKey>,
 * which in files mode is data/workspace/<ownerId>/files/<classKey>/_meta.json.
 */
function classFilesPrefix(ownerId, classId) {
  return `${ownerCollection(ownerId)}/files/${safeClassKey(classId)}`;
}

function safeTodoKey(raw) {
  const key = String(raw || "")
    .trim()
    .replace(/^local:/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 80);
  if (!key || key === "." || key === "..") {
    const err = new Error("Unknown todo.");
    err.status = 404;
    throw err;
  }
  return key;
}

/** Todo files: blob key workspace/<ownerId>/files/todos/<todoKey>/<name>, sidecar doc _meta. */
function todoFilesPrefix(ownerId, todoId) {
  return `${ownerCollection(ownerId)}/files/todos/${safeTodoKey(todoId)}`;
}

function originalTodoId(raw, stored = "") {
  const given = String(raw || "").trim();
  if (given) return given;
  const kept = String(stored || "").trim();
  if (kept) return kept;
  return "";
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
  const raw = await getDoc(ownerCollection(ownerId), "meta");
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
  await putDoc(ownerCollection(ownerId), "meta", {
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
  const collection = todosCollection(ownerId);
  const ids = await listIds(collection);
  const rows = [];
  for (const id of ids) {
    if (!ID_RE.test(id)) continue;
    const todo = await getDoc(collection, id);
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
  const todo = await getDoc(todosCollection(ownerId), id);
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
  await putDoc(todosCollection(ownerId), todo.id, todo);
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
  await putDoc(todosCollection(ownerId), todo.id, todo);
  return publicTodo(todo);
}

export async function deleteTodo(ownerId, rawId) {
  const todo = await loadTodo(ownerId, rawId);
  await deleteDoc(todosCollection(ownerId), todo.id);
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

/** `prefix` is a class or todo files prefix (collection for the sidecar, key prefix for blobs). */
async function readClassFileMeta(prefix) {
  const raw = await getDoc(prefix, META_DOC);
  return raw && typeof raw === "object" ? raw : {};
}

async function writeClassFileMeta(prefix, meta) {
  await putDoc(prefix, META_DOC, meta);
}

/**
 * Direct children of a blob prefix, like the old readdir + stat.isFile.
 * Returns [{ name, size, updated }] and skips the sidecar and dotfiles.
 */
async function listFilesUnder(prefix) {
  const base = `${prefix}/`;
  const rows = await listBlobs(base);
  const out = [];
  for (const blob of rows) {
    const name = blob.key.slice(base.length);
    if (!name || name.includes("/")) continue;
    if (name === META_NAME || name.startsWith(".")) continue;
    out.push({ name, size: blob.size, updated: blob.updated });
  }
  return out;
}

/** First path segment under `<prefix>/` for every blob, deduped. Stands in for readdir of subfolders. */
async function listChildDirs(prefix) {
  const base = `${prefix}/`;
  const rows = await listBlobs(base);
  const seen = new Set();
  for (const blob of rows) {
    const rest = blob.key.slice(base.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    seen.add(rest.slice(0, slash));
  }
  return [...seen];
}

async function readTextPreview(key, contentType, name, size) {
  if (!isTextType(contentType, name) || size > MAX_HTML_PREVIEW) return undefined;
  try {
    const buf = await getBlob(key);
    return buf ? buf.toString("utf8") : undefined;
  } catch {
    return undefined;
  }
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
  const prefix = classFilesPrefix(ownerId, key);
  const files = await listFilesUnder(prefix);
  if (!files.length) return [];
  const meta = await readClassFileMeta(prefix);
  const out = [];
  for (const file of files) {
    const row = meta[file.name] && typeof meta[file.name] === "object" ? meta[file.name] : {};
    const contentType = String(row.contentType || guessContentType(file.name, ""));
    const text = includeText
      ? await readTextPreview(`${prefix}/${file.name}`, contentType, file.name, file.size)
      : undefined;
    out.push(
      publicClassFile(
        classId,
        file.name,
        file.size,
        row.lastModified || file.updated,
        contentType,
        text
      )
    );
  }
  out.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)));
  return out;
}

export async function listAllClassFiles(ownerId, { includeText = false } = {}) {
  const classIds = await listChildDirs(`${ownerCollection(ownerId)}/files`);
  const out = [];
  for (const classId of classIds) {
    if (classId.startsWith(".") || classId === "todos") continue;
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
  const prefix = classFilesPrefix(ownerId, key);
  const type = guessContentType(safe, contentType);
  await putBlob(`${prefix}/${safe}`, buf, { contentType: type });
  const lastModified = new Date().toISOString();
  const meta = await readClassFileMeta(prefix);
  meta[safe] = { contentType: type, lastModified };
  await writeClassFileMeta(prefix, meta);
  const text = isTextType(type, safe) && buf.length <= MAX_HTML_PREVIEW ? buf.toString("utf8") : undefined;
  return publicClassFile(classId, safe, buf.length, lastModified, type, text);
}

export async function readClassFile(ownerId, classId, name) {
  const key = safeClassKey(classId);
  const safe = safeFileName(name);
  const prefix = classFilesPrefix(ownerId, key);
  const buffer = await getBlob(`${prefix}/${safe}`);
  if (!buffer) {
    throw Object.assign(new Error("file not found"), { status: 404 });
  }
  const meta = await readClassFileMeta(prefix);
  const contentType = String(meta[safe]?.contentType || guessContentType(safe, ""));
  return { name: safe, classId: key, contentType, buffer };
}

export async function deleteClassFile(ownerId, classId, name) {
  const key = safeClassKey(classId);
  const safe = safeFileName(name);
  const prefix = classFilesPrefix(ownerId, key);
  const removed = await deleteBlob(`${prefix}/${safe}`);
  if (!removed) {
    throw Object.assign(new Error("file not found"), { status: 404 });
  }
  const meta = await readClassFileMeta(prefix);
  delete meta[safe];
  await writeClassFileMeta(prefix, meta);
  return { ok: true, id: classFileId(classId, safe) };
}

function todoFileId(todoId, name) {
  return `${TODO_FILE_PREFIX}${todoId}:${name}`;
}

export function parseTodoFileId(raw) {
  const id = String(raw || "").trim();
  if (!id.startsWith(TODO_FILE_PREFIX)) return null;
  const rest = id.slice(TODO_FILE_PREFIX.length);
  if (rest.toLowerCase().startsWith(LOCAL_PREFIX)) {
    const afterLocal = rest.slice(LOCAL_PREFIX.length);
    const colon = afterLocal.indexOf(":");
    if (colon < 1) return null;
    return { todoId: `${LOCAL_PREFIX}${afterLocal.slice(0, colon)}`, name: afterLocal.slice(colon + 1) };
  }
  const colon = rest.indexOf(":");
  if (colon < 1) return null;
  return { todoId: rest.slice(0, colon), name: rest.slice(colon + 1) };
}

function publicTodoFile(todoId, name, size, lastModified, contentType, text) {
  const row = {
    id: todoFileId(todoId, name),
    name,
    size: Number(size) || 0,
    lastModified: String(lastModified || ""),
    folder: false,
    webUrl: "",
    downloadUrl: "",
    source: "todo",
    todoId: String(todoId || ""),
    contentType: contentType || "application/octet-stream",
  };
  if (text != null) row.text = text;
  return row;
}

export async function listTodoFiles(ownerId, todoId, { includeText = false } = {}) {
  const publicId = originalTodoId(todoId);
  const prefix = todoFilesPrefix(ownerId, todoId);
  const files = await listFilesUnder(prefix);
  if (!files.length) return [];
  const meta = await readClassFileMeta(prefix);
  const keptId = originalTodoId(publicId, meta._todoId);
  const out = [];
  for (const file of files) {
    const row = meta[file.name] && typeof meta[file.name] === "object" ? meta[file.name] : {};
    const contentType = String(row.contentType || guessContentType(file.name, ""));
    const text = includeText
      ? await readTextPreview(`${prefix}/${file.name}`, contentType, file.name, file.size)
      : undefined;
    out.push(
      publicTodoFile(
        keptId || publicId,
        file.name,
        file.size,
        row.lastModified || file.updated,
        contentType,
        text
      )
    );
  }
  out.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)));
  return out;
}

export async function listAllTodoFiles(ownerId, { includeText = false } = {}) {
  const root = `${ownerCollection(ownerId)}/files/todos`;
  const keys = await listChildDirs(root);
  const out = [];
  for (const key of keys) {
    if (key.startsWith(".")) continue;
    const meta = await readClassFileMeta(`${root}/${key}`);
    const todoId = originalTodoId(meta._todoId, ID_RE.test(key) ? publicTodoId(key) : key);
    out.push(...(await listTodoFiles(ownerId, todoId || key, { includeText })));
  }
  return out;
}

export async function writeTodoFile(ownerId, todoId, { name, content, contentType, encoding } = {}) {
  const publicId = originalTodoId(todoId);
  if (!publicId) {
    throw Object.assign(new Error("todo id required"), { status: 400 });
  }
  const safe = safeFileName(name);
  const buf = toBuffer(content, encoding);
  if (buf.length > MAX_FILE_BYTES) {
    throw Object.assign(new Error("File is too large (2MB max)."), { status: 400 });
  }
  const prefix = todoFilesPrefix(ownerId, publicId);
  const type = guessContentType(safe, contentType);
  await putBlob(`${prefix}/${safe}`, buf, { contentType: type });
  const lastModified = new Date().toISOString();
  const meta = await readClassFileMeta(prefix);
  meta._todoId = publicId;
  meta[safe] = { contentType: type, lastModified };
  await writeClassFileMeta(prefix, meta);
  const text = isTextType(type, safe) && buf.length <= MAX_HTML_PREVIEW ? buf.toString("utf8") : undefined;
  return publicTodoFile(publicId, safe, buf.length, lastModified, type, text);
}

export async function readTodoFile(ownerId, todoId, name) {
  const publicId = originalTodoId(todoId);
  const safe = safeFileName(name);
  const prefix = todoFilesPrefix(ownerId, publicId || todoId);
  const buffer = await getBlob(`${prefix}/${safe}`);
  if (!buffer) {
    throw Object.assign(new Error("file not found"), { status: 404 });
  }
  const meta = await readClassFileMeta(prefix);
  const contentType = String(meta[safe]?.contentType || guessContentType(safe, ""));
  return { name: safe, todoId: originalTodoId(publicId, meta._todoId), contentType, buffer };
}

export async function deleteTodoFile(ownerId, todoId, name) {
  const publicId = originalTodoId(todoId);
  const safe = safeFileName(name);
  const prefix = todoFilesPrefix(ownerId, publicId || todoId);
  const removed = await deleteBlob(`${prefix}/${safe}`);
  if (!removed) {
    throw Object.assign(new Error("file not found"), { status: 404 });
  }
  const meta = await readClassFileMeta(prefix);
  delete meta[safe];
  await writeClassFileMeta(prefix, meta);
  return { ok: true, id: todoFileId(originalTodoId(publicId, meta._todoId) || publicId, safe) };
}

/**
 * Account deletion: todos, the workspace meta doc, every class file and todo file
 * blob, and their _meta sidecars. Idempotent. Sidecar keys come from the blob
 * keys plus listIds, so both the files and the Firestore/GCS layouts are covered.
 */
export async function deleteOwnerData(ownerId) {
  const owner = ownerCollection(ownerId);
  const out = { todos: 0, files: 0, meta: false };

  const todosCol = todosCollection(ownerId);
  for (const id of await listIds(todosCol)) {
    if (await deleteDoc(todosCol, id).catch(() => false)) out.todos += 1;
  }

  const filesBase = `${owner}/files/`;
  const todosBase = `${filesBase}todos/`;
  const classKeys = new Set();
  const todoKeys = new Set();
  for (const blob of await listBlobs(filesBase)) {
    const rest = blob.key.slice(filesBase.length);
    if (rest.startsWith("todos/")) {
      const key = rest.slice("todos/".length).split("/")[0];
      if (key) todoKeys.add(key);
    } else {
      const key = rest.split("/")[0];
      if (key) classKeys.add(key);
    }
    if (await deleteBlob(blob.key).catch(() => false)) out.files += 1;
  }
  for (const key of await listIds(`${owner}/files`).catch(() => [])) {
    if (key !== "todos") classKeys.add(key);
  }
  for (const key of await listIds(`${owner}/files/todos`).catch(() => [])) todoKeys.add(key);
  for (const key of classKeys) {
    await deleteDoc(`${owner}/files/${key}`, META_DOC).catch(() => false);
  }
  for (const key of todoKeys) {
    await deleteDoc(`${todosBase.slice(0, -1)}/${key}`, META_DOC).catch(() => false);
  }

  out.meta = await deleteDoc(owner, "meta").catch(() => false);
  return out;
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
    const todoFiles = await listAllTodoFiles(ownerId);
    if (todoFiles.length) {
      bits.push(
        `Todo files (${todoFiles.length}): ${todoFiles
          .slice(0, 16)
          .map((f) => `${f.name} [${f.todoId}]`)
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
