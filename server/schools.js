/**
 * School catalog plus optional student-id rosters.
 * Public JSON never includes roster names.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LIST_CAP = 50;

const EASTSIDE = {
  slug: "eastside-prep",
  name: "Eastside Prep",
  shortName: "EPS",
  domain: "eastsideprep.org",
  canvasHost: "https://eastsideprep.instructure.com",
  roster: {},
};

export function schoolsDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "data", "schools");
}

function assertSlug(raw) {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!slug || slug.length > 80 || slug.includes("..") || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Invalid school slug.");
  }
  return slug;
}

function schoolPath(slug) {
  const id = assertSlug(slug);
  const dir = resolve(schoolsDir());
  const full = resolve(dir, `${id}.json`);
  if (full !== join(dir, `${id}.json`) && !full.startsWith(dir + sep)) {
    throw new Error("Invalid school slug.");
  }
  return full;
}

function hydrate(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const roster = {};
  const srcRoster =
    src.roster && typeof src.roster === "object" && !Array.isArray(src.roster) ? src.roster : {};
  for (const [id, name] of Object.entries(srcRoster)) {
    const sid = String(id || "").trim();
    const n = String(name || "").trim();
    if (sid && n) roster[sid] = n;
  }
  return {
    slug: String(src.slug || ""),
    name: String(src.name || ""),
    shortName: String(src.shortName || ""),
    domain: String(src.domain || ""),
    canvasHost: String(src.canvasHost || ""),
    roster,
  };
}

export function publicSchool(school) {
  const s = hydrate(school);
  const rosterCount = Object.keys(s.roster).length;
  return {
    slug: s.slug,
    name: s.name,
    shortName: s.shortName,
    domain: s.domain,
    canvasHost: s.canvasHost,
    hasRoster: rosterCount > 0,
    rosterCount,
  };
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

async function seedEastside() {
  await mkdir(schoolsDir(), { recursive: true });
  try {
    await readFile(schoolPath(EASTSIDE.slug), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    await writeJsonAtomic(schoolPath(EASTSIDE.slug), EASTSIDE);
  }
}

const seedReady = seedEastside();

export async function getSchool(slug) {
  await seedReady;
  let path;
  try {
    path = schoolPath(slug);
  } catch {
    return null;
  }
  try {
    return hydrate(JSON.parse(await readFile(path, "utf8")));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function haystack(school) {
  return [school.name, school.shortName, school.slug, school.domain]
    .map((s) => String(s || "").toLowerCase())
    .join("\n");
}

export async function listSchools(query) {
  await seedReady;
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  let names;
  try {
    names = await readdir(schoolsDir());
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const school = await getSchool(name.slice(0, -5));
    if (!school) continue;
    if (q && !haystack(school).includes(q)) continue;
    out.push(publicSchool(school));
    if (out.length >= LIST_CAP) break;
  }
  return out;
}

export async function resolveSchool(raw) {
  const q = String(raw || "").trim();
  if (!q) return null;
  const asSlug = q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (asSlug) {
    const direct = await getSchool(asSlug);
    if (direct) return direct;
  }
  const listed = await listSchools(q);
  const needle = q.toLowerCase();
  for (const pub of listed) {
    if (
      pub.slug === asSlug ||
      pub.name.toLowerCase() === needle ||
      pub.shortName.toLowerCase() === needle ||
      pub.domain.toLowerCase() === needle
    ) {
      return getSchool(pub.slug);
    }
  }
  return listed[0] ? getSchool(listed[0].slug) : null;
}

export async function lookupRosterName(slug, studentId) {
  const school = await getSchool(slug);
  if (!school) return "";
  return String(school.roster[String(studentId || "").trim()] || "").trim();
}

function rosterEntries(entries) {
  const out = {};
  if (Array.isArray(entries)) {
    for (const row of entries) {
      const id = String(row?.studentId ?? "").trim();
      const name = String(row?.name ?? "").trim();
      if (id && name) out[id] = name;
    }
    return out;
  }
  if (entries && typeof entries === "object") {
    for (const [id, name] of Object.entries(entries)) {
      const sid = String(id || "").trim();
      const n = String(typeof name === "object" ? name?.name || "" : name || "").trim();
      if (sid && n) out[sid] = n;
    }
  }
  return out;
}

export async function setRoster(slug, entries) {
  const school = await getSchool(slug);
  if (!school) {
    const err = new Error("School not found.");
    err.status = 404;
    throw err;
  }
  school.roster = { ...school.roster, ...rosterEntries(entries) };
  await writeJsonAtomic(schoolPath(school.slug), school);
  return school;
}
