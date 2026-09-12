/**
 * Local per-student files so the Files page still works when Graph is blocked.
 * Lives next to student profiles: server/data/vault/{googleFileId}/
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 2 * 1024 * 1024;
const META_NAME = "_meta.json";

export function vaultRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "data", "vault");
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

function studentDir(fileId) {
  const id = assertFileId(fileId);
  const root = resolve(vaultRoot());
  const full = resolve(root, id);
  if (full !== join(root, id) && !full.startsWith(root + sep)) {
    throw new Error("Invalid student file id.");
  }
  return full;
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

function filePath(dir, name) {
  const safe = safeVaultName(name);
  const full = resolve(dir, safe);
  if (full !== join(dir, safe) && !full.startsWith(dir + sep)) {
    throw new Error("invalid file name");
  }
  return full;
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

async function readMeta(dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir, META_NAME), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

async function writeMeta(dir, meta) {
  await writeFile(join(dir, META_NAME), JSON.stringify(meta, null, 2), "utf8");
}

export async function listVault(fileId) {
  let dir;
  try {
    dir = studentDir(fileId);
  } catch {
    return [];
  }
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const meta = await readMeta(dir);
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
    out.push(vaultItem(name, info.size, row.lastModified || info.mtime.toISOString()));
  }
  out.sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)));
  return out;
}

export async function saveVault(fileId, { name, content, contentType } = {}) {
  const dir = studentDir(fileId);
  const safe = safeVaultName(name);
  const buf = toBuffer(content);
  if (buf.length > MAX_BYTES) throw new Error("File is too large (2MB max).");
  await mkdir(dir, { recursive: true });
  await writeFile(filePath(dir, safe), buf);
  const lastModified = new Date().toISOString();
  const type = String(contentType || "application/octet-stream").trim();
  const meta = await readMeta(dir);
  meta[safe] = { contentType: type, lastModified };
  await writeMeta(dir, meta);
  return vaultItem(safe, buf.length, lastModified);
}

export async function readVault(fileId, name) {
  const dir = studentDir(fileId);
  const safe = safeVaultName(name);
  let buffer;
  try {
    buffer = await readFile(filePath(dir, safe));
  } catch (err) {
    if (err?.code === "ENOENT") {
      const missing = new Error("file not found");
      missing.status = 404;
      throw missing;
    }
    throw err;
  }
  const meta = await readMeta(dir);
  const type = String(meta[safe]?.contentType || "application/octet-stream").trim();
  return { name: safe, contentType: type, buffer };
}
