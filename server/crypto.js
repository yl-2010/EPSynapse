/**
 * AES-256-GCM for student secrets at rest (Canvas tokens, model keys, Graph tokens).
 *
 * Key: DATA_ENCRYPTION_KEY, 32 bytes as base64 or hex. Generate one with
 *   openssl rand -base64 32
 *
 * Stored form: enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * With the key unset, sealSecret() returns the plaintext unchanged and a single
 * warning is logged at import. openSecret() passes plaintext through untouched,
 * so files written before the key existed still load; the next save seals them.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function parseKey(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  let buf;
  try {
    buf = Buffer.from(text, "base64");
  } catch {
    buf = Buffer.alloc(0);
  }
  if (buf.length === KEY_BYTES) return buf;
  throw new Error(
    "DATA_ENCRYPTION_KEY must be 32 bytes as base64 or hex (try: openssl rand -base64 32)."
  );
}

const KEY = parseKey(process.env.DATA_ENCRYPTION_KEY);

if (!KEY) {
  console.warn("DATA_ENCRYPTION_KEY unset: student secrets are stored in plaintext");
}

export function encryptionEnabled() {
  return Boolean(KEY);
}

export function isSealed(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Plaintext -> enc:v1:... when a key is set. "" stays "". Already sealed values pass through. */
export function sealSecret(plain) {
  const text = plain == null ? "" : String(plain);
  if (!text) return "";
  if (!KEY) return text;
  if (isSealed(text)) return text;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** enc:v1:... -> plaintext. Anything without the prefix is returned as-is. */
export function openSecret(stored) {
  const text = stored == null ? "" : String(stored);
  if (!isSealed(text)) return text;
  if (!KEY) {
    throw keyError(
      "A stored secret is encrypted but DATA_ENCRYPTION_KEY is unset. Set the key that wrote it."
    );
  }
  const parts = text.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw keyError("Encrypted secret is malformed.");
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const ct = Buffer.from(parts[2], "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw keyError("Encrypted secret is malformed.");
  }
  try {
    const decipher = createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw keyError(
      "Could not decrypt a stored secret: DATA_ENCRYPTION_KEY does not match the key that wrote it."
    );
  }
}

/** Errors from openSecret carry this code so callers can tell "wrong key" from "no such student". */
export const SECRET_KEY_ERROR = "E_SECRET_KEY";

function keyError(message) {
  const err = new Error(message);
  err.code = SECRET_KEY_ERROR;
  return err;
}
