/**
 * Binary files (uploaded PDFs, vault files, class and todo files).
 *
 *   BLOB_BACKEND=files  (default) bytes under server/data/<key>, same paths as today
 *   BLOB_BACKEND=gcs    Google Cloud Storage object <GCS_PREFIX><key> in GCS_BUCKET
 *
 * A key is a slash path relative to server/data, for example
 *   vault/<fileId>/<name>
 *   workspace/<ownerId>/files/<classKey>/<name>
 *   workspace/<ownerId>/files/todos/<todoKey>/<name>
 *   schedules/<ownerId>/<pdfName>          (second pass, schedule.js)
 *
 * The JSON sidecars next to those files (`_meta.json`, `classes.json`) are
 * documents and go through store.js, not here.
 *
 * GCS_BUCKET defaults to the App Engine default bucket `<project>.appspot.com`
 * so a fresh project deploys with no bucket config. Set GCS_BUCKET to use a
 * named bucket instead. The Google client is imported only in gcs mode.
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { dataRoot } from "./store.js";

let storageClient = null;

export function blobBackend() {
  const raw = String(process.env.BLOB_BACKEND || "files").trim().toLowerCase();
  if (raw === "gcs") return "gcs";
  if (raw === "files" || raw === "") return "files";
  throw new Error(`Unknown BLOB_BACKEND "${raw}" (use files or gcs).`);
}

function normalizeKey(raw, { allowTrailingSlash = false } = {}) {
  const key = String(raw ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!key) throw new Error("Empty blob key.");
  if (key.includes("\0")) throw new Error("Invalid blob key.");
  const parts = key.split("/");
  parts.forEach((seg, i) => {
    const last = i === parts.length - 1;
    if (!seg) {
      if (last && allowTrailingSlash) return;
      throw new Error("Invalid blob key: empty segment.");
    }
    if (seg === "." || seg === "..") throw new Error("Invalid blob key.");
  });
  return key;
}

/* ---------------- files backend ---------------- */

/** Absolute path of a blob in files mode. Exported for the migration tool. */
export function blobFilePath(key) {
  const clean = normalizeKey(key);
  const base = resolve(dataRoot());
  const full = resolve(base, ...clean.split("/"));
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error("Blob key escapes the data directory.");
  }
  return full;
}

async function filesPut(key, buffer) {
  const path = blobFilePath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

async function filesGet(key) {
  try {
    return await readFile(blobFilePath(key));
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function filesDelete(key) {
  try {
    await unlink(blobFilePath(key));
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

async function walk(dir, relPrefix, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    const rel = `${relPrefix}${entry.name}`;
    if (entry.isDirectory()) {
      await walk(full, `${rel}/`, out);
      continue;
    }
    if (!entry.isFile()) continue;
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    out.push({ key: rel, size: info.size, updated: info.mtime.toISOString(), contentType: "" });
  }
}

async function filesList(prefix) {
  const clean = prefix ? normalizeKey(prefix, { allowTrailingSlash: true }) : "";
  const base = resolve(dataRoot());
  const out = [];
  if (!clean || clean.endsWith("/")) {
    const dir = clean ? blobFilePath(clean.slice(0, -1)) : base;
    await walk(dir, clean, out);
    return out;
  }
  // Prefix ends mid-name: list the parent directory and filter.
  const idx = clean.lastIndexOf("/");
  const parentRel = idx === -1 ? "" : clean.slice(0, idx + 1);
  const dir = parentRel ? blobFilePath(parentRel.slice(0, -1)) : base;
  await walk(dir, parentRel, out);
  return out.filter((row) => row.key.startsWith(clean));
}

/* ---------------- gcs backend ---------------- */

export function gcsBucketName() {
  const named = String(process.env.GCS_BUCKET || "").trim();
  if (named) return named;
  const project = String(process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  if (project) return `${project}.appspot.com`;
  throw new Error("Set GCS_BUCKET (or GOOGLE_CLOUD_PROJECT) for BLOB_BACKEND=gcs.");
}

function objectName(key) {
  const prefix = String(process.env.GCS_PREFIX || "").replace(/^\/+/, "");
  return `${prefix}${normalizeKey(key)}`;
}

async function bucket() {
  if (!storageClient) {
    const { Storage } = await import("@google-cloud/storage");
    storageClient = new Storage();
  }
  return storageClient.bucket(gcsBucketName());
}

async function gcsPut(key, buffer, contentType) {
  const file = (await bucket()).file(objectName(key));
  await file.save(buffer, {
    resumable: false,
    contentType: contentType || "application/octet-stream",
  });
}

/** 404 for a missing object is normal. 404 for a missing bucket is a config error and must surface. */
function isMissingObject(err) {
  return Boolean(err) && err.code === 404 && !/bucket/i.test(String(err.message || ""));
}

async function gcsGet(key) {
  const file = (await bucket()).file(objectName(key));
  try {
    const [buf] = await file.download();
    return buf;
  } catch (err) {
    if (isMissingObject(err)) return null;
    throw err;
  }
}

async function gcsDelete(key) {
  const file = (await bucket()).file(objectName(key));
  try {
    await file.delete();
    return true;
  } catch (err) {
    if (isMissingObject(err)) return false;
    throw err;
  }
}

async function gcsList(prefix) {
  const b = await bucket();
  const objPrefix = String(process.env.GCS_PREFIX || "").replace(/^\/+/, "");
  const clean = prefix ? normalizeKey(prefix, { allowTrailingSlash: true }) : "";
  const [files] = await b.getFiles({ prefix: `${objPrefix}${clean}`, autoPaginate: true });
  return files
    .map((f) => ({
      key: String(f.name || "").slice(objPrefix.length),
      size: Number(f.metadata?.size) || 0,
      updated: String(f.metadata?.updated || f.metadata?.timeCreated || ""),
      contentType: String(f.metadata?.contentType || ""),
    }))
    .filter((row) => row.key && !row.key.endsWith("/"));
}

/* ---------------- public API ---------------- */

export async function putBlob(key, buffer, { contentType } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error("putBlob needs a Buffer.");
  return blobBackend() === "gcs" ? gcsPut(key, buffer, contentType) : filesPut(key, buffer);
}

/** @returns {Promise<Buffer|null>} */
export async function getBlob(key) {
  return blobBackend() === "gcs" ? gcsGet(key) : filesGet(key);
}

/** @returns {Promise<boolean>} true when something was removed */
export async function deleteBlob(key) {
  return blobBackend() === "gcs" ? gcsDelete(key) : filesDelete(key);
}

/**
 * Every blob whose key starts with prefix, recursively (flat namespace like GCS).
 * @returns {Promise<Array<{ key: string, size: number, updated: string, contentType: string }>>}
 */
export async function listBlobs(prefix = "") {
  return blobBackend() === "gcs" ? gcsList(prefix) : filesList(prefix);
}
