#!/usr/bin/env node
/**
 * Seal plaintext student secrets on disk with DATA_ENCRYPTION_KEY.
 *
 *   node --env-file=.env tools/reseal-students.mjs --dry-run
 *   node --env-file=.env tools/reseal-students.mjs
 *
 * Loads every student doc, checks whether any secret field (Canvas tokens, model keys,
 * Graph tokens, PKCE verifier) is still plaintext, and re-saves those so students.js
 * writes them as enc:v1:... Prints counts only, never a secret. Run from server/.
 */

import { encryptionEnabled } from "../crypto.js";
import { forEachStudentFile, resealStudentFile } from "../students.js";

const dryRun = process.argv.includes("--dry-run");

if (!encryptionEnabled()) {
  console.error("DATA_ENCRYPTION_KEY is not set. Nothing to seal with. Add it to server/.env first.");
  process.exit(2);
}

let total = 0;
let needed = 0;
let sealed = 0;
let failed = 0;

await forEachStudentFile(async (_student, fileId) => {
  total += 1;
  try {
    const r = await resealStudentFile(fileId, { dryRun });
    if (r.needed) needed += 1;
    if (r.sealed) sealed += 1;
  } catch (err) {
    failed += 1;
    console.error(`${fileId}: ${err?.message || err}`);
  }
  return false;
});

console.log(
  `${dryRun ? "dry run: " : ""}${total} student(s), ${needed} with plaintext secrets, ${sealed} resealed, ${failed} failed`
);
process.exit(failed ? 1 : 0);
