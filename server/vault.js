/**
 * Local per-student files so the Files page still works when Graph is blocked.
 * Lives next to student profiles: server/data/vault/{googleFileId}/
 * Bytes go through blobs.js (key vault/<fileId>/<name>), the per-file
 * contentType/lastModified sidecar through store.js (vault/<fileId> doc _meta).
 */

import { join } from "node:path";
import { getBlob, listBlobs, putBlob } from "./blobs.js";
import { dataRoot, getDoc, putDoc } from "./store.js";

const MAX_BYTES = 2 * 1024 * 1024;
const META_NAME = "_meta.json";
const META_DOC = "_meta";
const VAULT = "vault";

/** Files-mode directory (server/data/vault). Meaningless under GCS. */
export function vaultRoot() {
  return join(dataRoot(), VAULT);
}

function assertFileId(fileId) {
  const id = String(fileId ?? "").trim();
  if (
    !id ||
    id.length > 180 ||
    id.includes("..") ||
    !/^[a-z0-9._-]+__[a-z0-9._-]+$/.test(id)
  ) {
    throw new Error("Invalid student file id.");
  }
  return id;
}

/** store.js collection: vault/<fileId> -> data/vault/<fileId>/_meta.json */
function metaCollection(fileId) {
  return `${VAULT}/${assertFileId(fileId)}`;
}

/** blobs.js key prefix: vault/<fileId>/ */
function blobPrefix(fileId) {
  return `${VAULT}/${assertFileId(fileId)}/`;
}

export function safeVaultName(name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("file name required");
  if (/[/\\]/.test(n) || n.includes("\0")) {
    throw new Error("file name cannot contain slashes");
  }
  if (n === "." || n === ".." || n === META_NAME) throw new Error("invalid file name");
  if (n.length > 180) throw new Error("file name is too long");
  return n;
}

function blobKey(fileId, name) {
  return `${blobPrefix(fileId)}${safeVaultName(name)}`;
}

function toBuffer(content) {
  if (content === undefined || content === null) throw new Error("file content required");
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  return Buffer.from(String(content), "utf8");
}

function vaultItem(name, size, lastModified) {
  return {
    id: `vault:${name}`,
    name,
    size: Number(size) || 0,
    lastModified: String(lastModified || "").trim(),
    folder: false,
    webUrl: "",
    downloadUrl: "",
    source: "vault",
  };
}

async function readMeta(fileId) {
  try {
    const raw = await getDoc(metaCollection(fileId), META_DOC);
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

async function writeMeta(fileId, meta) {
  await putDoc(metaCollection(fileId), META_DOC, meta);
}

export async function listVault(fileId) {
  let id;
  try {
    id = assertFileId(fileId);
  } catch {
    return [];
  }
  const prefix = blobPrefix(id);
  const blobs = await listBlobs(prefix);
  const meta = await readMeta(id);
  const out = [];
  for (const blob of blobs) {
    const name = blob.key.slice(prefix.length);
    // Only direct children, same as the old readdir + isFile.
    if (!name || name.includes("/")) continue;
    if (name === META_NAME || name.startsWith(".")) continue;
    const row = meta[name] && typeof meta[name] === "object" ? meta[name] : {};
    out.push(vaultItem(name, blob.size, row.lastModified || blob.updated));
  }
  out.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)));
  return out;
}

export async function saveVault(fileId, { name, content, contentType } = {}) {
  const id = assertFileId(fileId);
  const safe = safeVaultName(name);
  const buf = toBuffer(content);
  if (buf.length > MAX_BYTES) throw new Error("File is too large (2MB max).");
  const type = String(contentType || "application/octet-stream").trim();
  await putBlob(blobKey(id, safe), buf, { contentType: type });
  const lastModified = new Date().toISOString();
  const meta = await readMeta(id);
  meta[safe] = { contentType: type, lastModified };
  await writeMeta(id, meta);
  return vaultItem(safe, buf.length, lastModified);
}

export async function readVault(fileId, name) {
  const id = assertFileId(fileId);
  const safe = safeVaultName(name);
  const buffer = await getBlob(blobKey(id, safe));
  if (!buffer) {
    const missing = new Error("file not found");
    missing.status = 404;
    throw missing;
  }
  const meta = await readMeta(id);
  const type = String(meta[safe]?.contentType || "application/octet-stream").trim();
  return { name: safe, contentType: type, buffer };
}
