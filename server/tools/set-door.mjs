#!/usr/bin/env node
/**
 * Move a student between doors and pause or resume them.
 *
 *   node --env-file=.env tools/set-door.mjs list
 *   node --env-file=.env tools/set-door.mjs <email> eps --pause
 *   node --env-file=.env tools/set-door.mjs <email> other --resume
 *
 * "list" prints every Google account that has signed in, with door and paused state,
 * so you can decide which ones are EPS students. Run from server/.
 */

import { findStudentByEmail, forEachStudentFile, setStudentDoor } from "../students.js";

const [cmd, ...rest] = process.argv.slice(2);

function usage(code = 1) {
  console.error("usage: set-door.mjs list | <email> <eps|other> [--pause|--resume]");
  process.exit(code);
}

if (!cmd) usage();

if (cmd === "list") {
  const rows = [];
  await forEachStudentFile(async (student, fileId) => {
    if (!fileId.startsWith("google__")) return false;
    rows.push({
      email: student.email || "(no email)",
      door: student.door,
      paused: student.paused ? "paused" : "active",
      lastSeen: (student.updatedAt || "").slice(0, 16).replace("T", " "),
    });
    return false;
  });
  rows.sort((a, b) => a.email.localeCompare(b.email));
  for (const r of rows) {
    console.log(`${r.email.padEnd(34)} ${r.door.padEnd(6)} ${r.paused.padEnd(7)} ${r.lastSeen}`);
  }
  process.exit(0);
}

const email = cmd;
const door = rest.find((a) => !a.startsWith("--"));
const pause = rest.includes("--pause") ? true : rest.includes("--resume") ? false : undefined;
if (!door && pause === undefined) usage();

const hit = await findStudentByEmail(email);
if (!hit) {
  console.error(`No student with email ${email}`);
  process.exit(2);
}
const saved = await setStudentDoor(hit.student, { door, paused: pause });
console.log(`${saved.email}: door=${saved.door} ${saved.paused ? "paused" : "active"}`);
