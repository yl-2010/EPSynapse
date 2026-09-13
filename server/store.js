/**
 * Tiny JSON document store with two backends.
 *
 *   STORAGE_BACKEND=files      (default) JSON files under server/data/, same layout as today
 *   STORAGE_BACKEND=firestore  Google Cloud Firestore (native mode), lazy-loaded client
 *
 * A "collection" is a slash path. An "id" is one path segment. In files mode
 * `collection/id` becomes `server/data/<collection>/<id>.json`, so the mapping
 * below resolves to the exact files the Mac deployment already writes. A few
 * top-level singletons are aliased so they keep their old file names.
 *
 * | collection                                    | id         | files path                                            | Firestore path                                              |
 * |-----------------------------------------------|------------|-------------------------------------------------------|-------------------------------------------------------------|
 * | students                                      | <fileId>   | data/students/<fileId>.json                           | students/<fileId>                                           |
 * | sessions                                      | all        | data/sessions.json                    (alias)         | sessions/all                                                |
 * | schools                                       | <slug>     | data/schools/<slug>.json                              | schools/<slug>                                              |
 * | meta                                          | research-metrics | data/research-metrics.json      (alias)         | meta/research-metrics                                       |
 * | notes/<ownerId>                               | <noteId>   | data/notes/<ownerId>/<noteId>.json                    | notes/<ownerId>/items/<noteId>                              |
 * | research/<ownerId>                            | <eventId>  | data/research/<ownerId>/<eventId>.json                | research/<ownerId>/items/<eventId>                          |
 * | chats/<ownerId>                               | <chatId>   | data/chats/<ownerId>/<chatId>.json                    | chats/<ownerId>/items/<chatId>                              |
 * | vault/<fileId>                                | _meta      | data/vault/<fileId>/_meta.json                        | vault/<fileId>/items/_meta                                  |
 * | workspace/<ownerId>                           | meta       | data/workspace/<ownerId>/meta.json                    | workspace/<ownerId>/items/meta                              |
 * | workspace/<ownerId>/todos                     | <todoId>   | data/workspace/<ownerId>/todos/<todoId>.json          | workspace/<ownerId>/todos/<todoId>                          |
 * | workspace/<ownerId>/files/<classKey>          | _meta      | data/workspace/<ownerId>/files/<classKey>/_meta.json  | workspace/<ownerId>/files/<classKey>/items/_meta            |
 * | workspace/<ownerId>/files/todos/<todoKey>     | _meta      | data/workspace/<ownerId>/files/todos/<todoKey>/_meta.json | workspace/<ownerId>/files/todos/<todoKey>/_meta         |
 * | schedules/<ownerId>  (second pass)            | classes    | data/schedules/<ownerId>/classes.json                 | schedules/<ownerId>/items/classes                           |
 *
 * Firestore paths must alternate collection/document. When the collection path
 * has an even number of segments (it ends on a document) we append the
 * subcollection name `items`. FIRESTORE_PREFIX (default "") is prepended to the
 * first segment only, e.g. FIRESTORE_PREFIX=eps_ gives `eps_students/<fileId>`.
 *
 * listIds(collection) returns document ids in that collection. In files mode
 * that is every `<id>.json` plus every directory name (a directory is a document
 * that only exists as the parent of a subcollection, which is also how Firestore
 * `listDocuments()` reports missing parents). Dotfiles and `*.tmp` are skipped.
 *
 * Binary files (PDFs, uploaded class files) do not live here. See blobs.js.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ID_BYTES = 1500;
const FIRESTORE_FILLER = "items";

/** Top-level docs that keep a flat file name in files mode. */
const FILE_ALIASES = {
  "sessions/all": "sessions.json",
  "meta/research-metrics": "research-metrics.json",
};

let firestoreClient = null;

export function storageBackend() {
  const raw = String(process.env.STORAGE_BACKEND || "files").trim().toLowerCase();
  if (raw === "firestore") return "firestore";
  if (raw === "files" || raw === "") return "files";
  throw new Error(`Unknown STORAGE_BACKEND "${raw}" (use files or firestore).`);
}

/** Root of the files backend. Override with EPSYNAPSE_DATA_DIR for tests. */
export function dataRoot() {
  const override = String(process.env.EPSYNAPSE_DATA_DIR || "").trim();
  if (override) return resolve(override);
  return join(dirname(fileURLToPath(import.meta.url)), "data");
}

function assertSegment(raw, what) {
  const seg = String(raw ?? "").trim();
  if (!seg) throw new Error(`Empty ${what}.`);
  if (seg === "." || seg === "..") throw new Error(`Invalid ${what}.`);
  if (/[/\\\0]/.test(seg)) throw new Error(`Invalid ${what}: no slashes.`);
  if (Buffer.byteLength(seg, "utf8") > MAX_ID_BYTES) throw new Error(`${what} is too long.`);
  if (/^__.*__$/.test(seg)) throw new Error(`Invalid ${what}.`);
  return seg;
}

export function assertDocId(raw) {
  return assertSegment(raw, "document id");
}

function collectionSegments(collection) {
  const raw = String(collection ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!raw) throw new Error("Empty collection.");
  return raw.split("/").map((s) => assertSegment(s, "collection segment"));
}

/* ---------------- files backend ---------------- */

function safeJoin(root, ...parts) {
  const base = resolve(root);
  const full = resolve(base, ...parts);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error("Path escapes the data directory.");
  }
  return full;
}

/** Absolute path of a doc in files mode. Exported for the migration tool. */
export function docFilePath(collection, id) {
  const segs = collectionSegments(collection);
  const docId = assertDocId(id);
  const alias = FILE_ALIASES[`${segs.join("/")}/${docId}`];
  if (alias) return safeJoin(dataRoot(), alias);
  return safeJoin(dataRoot(), ...segs, `${docId}.json`);
}

/** Inverse of docFilePath for a path relative to the data root. Migration helper. */
export function docRefFromRelativePath(relPath) {
  const rel = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  for (const [key, file] of Object.entries(FILE_ALIASES)) {
    if (rel === file) {
      const idx = key.lastIndexOf("/");
      return { collection: key.slice(0, idx), id: key.slice(idx + 1) };
    }
  }
  if (!rel.endsWith(".json")) return null;
  const parts = rel.slice(0, -5).split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { collection: parts.slice(0, -1).join("/"), id: parts[parts.length - 1] };
}

async function writeJsonAtomic(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function filesGet(collection, id) {
  try {
    const data = JSON.parse(await readFile(docFilePath(collection, id), "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function filesPut(collection, id, data) {
  await writeJsonAtomic(docFilePath(collection, id), data);
}

async function filesDelete(collection, id) {
  try {
    await unlink(docFilePath(collection, id));
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

async function filesListIds(collection) {
  const dir = safeJoin(dataRoot(), ...collectionSegments(collection));
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const ids = new Set();
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".") || name.endsWith(".tmp")) continue;
    if (entry.isDirectory()) {
      ids.add(name);
      continue;
    }
    if (entry.isFile() && name.endsWith(".json")) ids.add(name.slice(0, -5));
  }
  return [...ids];
}

/* ---------------- firestore backend ---------------- */

async function firestore() {
  if (firestoreClient) return firestoreClient;
  const { Firestore } = await import("@google-cloud/firestore");
  const opts = {};
  if (process.env.FIRESTORE_DATABASE_ID) opts.databaseId = process.env.FIRESTORE_DATABASE_ID;
  firestoreClient = new Firestore(opts);
  return firestoreClient;
}

function firestoreCollectionPath(collection) {
  const segs = collectionSegments(collection);
  const prefix = String(process.env.FIRESTORE_PREFIX || "").trim();
  segs[0] = `${prefix}${segs[0]}`;
  if (segs.length % 2 === 0) segs.push(FIRESTORE_FILLER);
  return segs.join("/");
}

async function firestoreCollectionRef(collection) {
  const db = await firestore();
  return db.collection(firestoreCollectionPath(collection));
}

/** Firestore rejects undefined; JSON round-trip matches what the files backend stores. */
function plainJson(data) {
  return JSON.parse(JSON.stringify(data ?? {}));
}

async function fsGet(collection, id) {
  const ref = (await firestoreCollectionRef(collection)).doc(assertDocId(id));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data && typeof data === "object" ? data : null;
}

async function fsPut(collection, id, data) {
  const ref = (await firestoreCollectionRef(collection)).doc(assertDocId(id));
  await ref.set(plainJson(data));
}

async function fsDelete(collection, id) {
  const ref = (await firestoreCollectionRef(collection)).doc(assertDocId(id));
  const snap = await ref.get();
  await ref.delete();
  return snap.exists;
}

async function fsListIds(collection) {
  const col = await firestoreCollectionRef(collection);
  const refs = await col.listDocuments();
  return refs.map((r) => r.id);
}

/* ---------------- public API ---------------- */

/** @returns {Promise<object|null>} */
export async function getDoc(collection, id) {
  return storageBackend() === "firestore" ? fsGet(collection, id) : filesGet(collection, id);
}

/** Atomic in files mode (tmp + rename, mode 0o600). Overwrites. */
export async function putDoc(collection, id, data) {
  if (!data || typeof data !== "object") throw new Error("putDoc needs an object.");
  return storageBackend() === "firestore" ? fsPut(collection, id, data) : filesPut(collection, id, data);
}

/** @returns {Promise<boolean>} true when something was removed */
export async function deleteDoc(collection, id) {
  return storageBackend() === "firestore" ? fsDelete(collection, id) : filesDelete(collection, id);
}

/** @returns {Promise<string[]>} */
export async function listIds(collection) {
  return storageBackend() === "firestore" ? fsListIds(collection) : filesListIds(collection);
}

/** @returns {Promise<Array<{ id: string, data: object }>>} docs that exist and parse; parents-only ids are skipped */
export async function listDocs(collection) {
  const ids = await listIds(collection);
  const out = [];
  for (const id of ids) {
    const data = await getDoc(collection, id).catch(() => null);
    if (data) out.push({ id, data });
  }
  return out;
}