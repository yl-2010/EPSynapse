#!/usr/bin/env node
/**
 * Copy everything under server/data/ into Firestore and Cloud Storage.
 *
 * Reads the Mac layout with plain fs, then writes through store.js/blobs.js
 * with the env pointed at the cloud backends. Idempotent: every write is a
 * put, so rerunning just overwrites the same docs and objects.
 *
 *   cd server
 *   STORAGE_BACKEND=firestore BLOB_BACKEND=gcs GOOGLE_CLOUD_PROJECT=<project> \
 *     node tools/migrate-to-gcp.mjs --dry-run
 *   ...same without --dry-run to copy.
 *
 * Flags
 *   --dry-run          print what would be written, write nothing
 *   --data-dir=PATH    source directory (default server/data)
 *   --only=students,notes,...   top-level folders to copy (default all)
 *   --allow-files      let the target backends be files/files (for tests with EPSYNAPSE_DATA_DIR)
 *
 * Which files are documents and which are blobs follows the tables at the top
 * of store.js and blobs.js:
 *   vault/<id>/*                 blobs, except _meta.json
 *   workspace/<owner>/files/**   blobs, except _meta.json
 *   schedules/<owner>/*          blobs, except classes.json
 *   everything else *.json       documents
 * The repo-root research-metrics.json is copied into doc meta/research-metrics
 * when server/data has no research-metrics.json of its own, because App Engine
 * only uploads server/.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "..");
const repoRoot = resolve(serverDir, "..");

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (!m) {
    console.error(`Unknown argument ${raw}`);
    process.exit(2);
  }
  args.set(m[1], m[2] ?? "1");
}

const dryRun = args.has("dry-run");
const allowFiles = args.has("allow-files");
const sourceDir = resolve(args.get("data-dir") || join(serverDir, "data"));
const only = new Set(
  String(args.get("only") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const { putDoc, storageBackend, docRefFromRelativePath } = await import("../store.js");
const { putBlob, blobBackend, gcsBucketName } = await import("../blobs.js");

const storage = storageBackend();
const blobs = blobBackend();
if (!dryRun && !allowFiles && storage === "files" && blobs === "files") {
  console.error(
    "Both backends are files. Set STORAGE_BACKEND=firestore and BLOB_BACKEND=gcs (or pass --allow-files for a local test)."
  );
  process.exit(2);
}
if (!dryRun && storage === "files" && !allowFiles && resolve(process.env.EPSYNAPSE_DATA_DIR || join(serverDir, "data")) === sourceDir) {
  console.error("Refusing to copy the data directory onto itself.");
  process.exit(2);
}

console.log(`source   ${sourceDir}`);
console.log(`docs  -> ${storage}${storage === "firestore" ? ` (prefix "${process.env.FIRESTORE_PREFIX || ""}")` : ""}`);
console.log(`blobs -> ${blobs}${blobs === "gcs" ? ` (bucket ${safeBucketName()})` : ""}`);
if (dryRun) console.log("dry run: nothing will be written");

function safeBucketName() {
  try {
    return gcsBucketName();
  } catch (err) {
    return `unset: ${err.message}`;
  }
}

function guessContentType(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/octet-stream";
}

/** Decide whether a relative path (posix, no leading slash) is a blob, a doc, or skipped. */
function classify(rel) {
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  if (name.startsWith(".") || name.endsWith(".tmp")) return { kind: "skip", why: "temp or dotfile" };

  const top = parts[0];
  if (top === "vault" && parts.length >= 3) {
    return name === "_meta.json" ? { kind: "doc" } : { kind: "blob" };
  }
  if (top === "workspace" && parts[2] === "files" && parts.length >= 5) {
    return name === "_meta.json" ? { kind: "doc" } : { kind: "blob" };
  }
  if (top === "schedules" && parts.length >= 3) {
    return name === "classes.json" ? { kind: "doc" } : { kind: "blob" };
  }
  if (name.endsWith(".json")) return { kind: "doc" };
  return { kind: "skip", why: "not a document or a known blob tree" };
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const counts = { docs: 0, blobs: 0, skipped: 0, failed: 0 };

async function copyDoc(collection, id, buf, label) {
  let data;
  try {
    data = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    counts.failed += 1;
    console.warn(`  ! ${label}: bad JSON (${err.message})`);
    return;
  }
  if (!data || typeof data !== "object") {
    counts.skipped += 1;
    console.warn(`  - ${label}: JSON is not an object, skipped`);
    return;
  }
  console.log(`  doc  ${collection} / ${id}   <- ${label}`);
  if (!dryRun) await putDoc(collection, id, data);
  counts.docs += 1;
}

async function copyBlob(key, buf, label) {
  console.log(`  blob ${key}  (${buf.length} bytes)   <- ${label}`);
  if (!dryRun) await putBlob(key, buf, { contentType: guessContentType(key) });
  counts.blobs += 1;
}

const files = (await walk(sourceDir, [])).sort();
for (const full of files) {
  const rel = relative(sourceDir, full).split("\\").join("/");
  const top = rel.split("/")[0];
  if (only.size && !only.has(top) && !only.has(rel)) continue;

  const what = classify(rel);
  if (what.kind === "skip") {
    counts.skipped += 1;
    console.log(`  -    ${rel}   (${what.why})`);
    continue;
  }
  let buf;
  try {
    buf = await readFile(full);
  } catch (err) {
    counts.failed += 1;
    console.warn(`  ! ${rel}: ${err.message}`);
    continue;
  }
  try {
    if (what.kind === "blob") {
      await copyBlob(rel, buf, rel);
    } else {
      const ref = docRefFromRelativePath(rel);
      if (!ref) {
        counts.skipped += 1;
        console.log(`  -    ${rel}   (no collection mapping)`);
        continue;
      }
      await copyDoc(ref.collection, ref.id, buf, rel);
    }
  } catch (err) {
    counts.failed += 1;
    console.warn(`  ! ${rel}: ${err.message}`);
  }
}

// Frozen research metrics: shipped at the repo root on the Mac, absent on App Engine.
if (!only.size || only.has("meta")) {
  const hasOwn = files.some((f) => relative(sourceDir, f) === "research-metrics.json");
  if (!hasOwn) {
    const frozen = join(repoRoot, "research-metrics.json");
    try {
      await stat(frozen);
      await copyDoc("meta", "research-metrics", await readFile(frozen), "../research-metrics.json");
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        counts.failed += 1;
        console.warn(`  ! research-metrics.json: ${err?.message || err}`);
      }
    }
  }
}

console.log(
  `${dryRun ? "would write" : "wrote"} ${counts.docs} docs, ${counts.blobs} blobs; skipped ${counts.skipped}; failed ${counts.failed}`
);
process.exit(counts.failed ? 1 : 0);
