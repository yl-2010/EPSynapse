/**
 * School OneNote via Microsoft Graph.
 * Uses the same Office device-code token as OneDrive (student.graph).
 */

import { GRAPH_BASE, graphGet } from "./onedrive.js";

const MAX_HTML = 80_000;

function enc(id) {
  return encodeURIComponent(String(id || "").trim());
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function pageHtml(title, body) {
  const t = String(title || "Untitled").trim() || "Untitled";
  const raw = String(body || "").trim();
  const inner = /<\/?[a-z][\s\S]*>/i.test(raw)
    ? raw
    : `<p>${raw
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n\n+/g, "</p><p>")
        .replace(/\n/g, "<br/>")}</p>`;
  return `<!DOCTYPE html><html><head><title>${t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</title></head><body>${inner}</body></html>`;
}

function mapNotebook(raw) {
  return {
    id: String(raw?.id || "").trim(),
    name: String(raw?.displayName || "").trim(),
    created: String(raw?.createdDateTime || "").trim(),
    lastModified: String(raw?.lastModifiedDateTime || "").trim(),
    isDefault: Boolean(raw?.isDefault),
    webUrl: String(raw?.links?.oneNoteWebUrl?.href || raw?.links?.oneNoteClientUrl?.href || "").trim(),
  };
}

function mapSection(raw) {
  return {
    id: String(raw?.id || "").trim(),
    name: String(raw?.displayName || "").trim(),
    notebookId: String(raw?.parentNotebook?.id || "").trim(),
    notebook: String(raw?.parentNotebook?.displayName || "").trim(),
    created: String(raw?.createdDateTime || "").trim(),
    lastModified: String(raw?.lastModifiedDateTime || "").trim(),
  };
}

function mapPage(raw) {
  return {
    id: String(raw?.id || "").trim(),
    title: String(raw?.title || "").trim(),
    created: String(raw?.createdDateTime || "").trim(),
    lastModified: String(raw?.lastModifiedDateTime || "").trim(),
    sectionId: String(raw?.parentSection?.id || "").trim(),
    section: String(raw?.parentSection?.displayName || "").trim(),
    webUrl: String(raw?.links?.oneNoteWebUrl?.href || "").trim(),
  };
}

function notesDenied(err) {
  const msg = String(err?.message || err || "");
  return /403|401|accessdenied|notes\./i.test(msg);
}

export function onenoteError(err) {
  if (notesDenied(err)) {
    return "OneNote needs Notes access on this Microsoft sign-in. Connect OneDrive again after school IT accepts the app.";
  }
  return String(err?.message || "OneNote request failed.");
}

export async function graphHtml(token, urlOrPath) {
  const s = String(urlOrPath || "").trim();
  const url = /^https?:\/\//i.test(s) ? s : `${GRAPH_BASE}${s.startsWith("/") ? s : `/${s}`}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.replace(/\s+/g, " ").slice(0, 220);
    const err = new Error(`Graph ${res.status}: ${snippet}`);
    err.status = res.status;
    throw err;
  }
  return text;
}

export async function listNotebooks(token) {
  const data = await graphGet(
    token,
    "/me/onenote/notebooks?$select=id,displayName,createdDateTime,lastModifiedDateTime,isDefault,links&$top=50"
  );
  return (Array.isArray(data.value) ? data.value : []).map(mapNotebook);
}

export async function listSections(token, notebookId) {
  const id = String(notebookId || "").trim();
  const path = id
    ? `/me/onenote/notebooks/${enc(id)}/sections?$select=id,displayName,createdDateTime,lastModifiedDateTime,parentNotebook&$top=80`
    : "/me/onenote/sections?$select=id,displayName,createdDateTime,lastModifiedDateTime,parentNotebook&$top=80";
  const data = await graphGet(token, path);
  return (Array.isArray(data.value) ? data.value : []).map(mapSection);
}

export async function listPages(token, { sectionId, q, limit } = {}) {
  const top = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const section = String(sectionId || "").trim();
  const search = String(q || "").trim();
  let path;
  if (search) {
    path = `/me/onenote/pages?search=${enc(search)}&$top=${top}`;
  } else if (section) {
    path = `/me/onenote/sections/${enc(section)}/pages?$select=id,title,createdDateTime,lastModifiedDateTime,links,parentSection&$top=${top}`;
  } else {
    path = `/me/onenote/pages?$select=id,title,createdDateTime,lastModifiedDateTime,links,parentSection&$top=${top}`;
  }
  const data = await graphGet(token, path);
  return (Array.isArray(data.value) ? data.value : []).map(mapPage);
}

export async function getPage(token, pageId) {
  const id = String(pageId || "").trim();
  if (!id) throw new Error("page id required");
  const meta = await graphGet(token, `/me/onenote/pages/${enc(id)}`);
  const html = await graphHtml(token, `/me/onenote/pages/${enc(id)}/content?includeIDs=true`);
  const clipped = html.length > MAX_HTML ? `${html.slice(0, MAX_HTML)}…` : html;
  return {
    ...mapPage(meta),
    html: clipped,
    text: htmlToText(clipped),
  };
}

export async function createPage(token, { sectionId, title, html, text } = {}) {
  const section = String(sectionId || "").trim();
  if (!section) throw new Error("section id required");
  const body = pageHtml(title, html || text || "");
  const res = await fetch(`${GRAPH_BASE}/me/onenote/sections/${enc(section)}/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/html",
    },
    body,
  });
  const raw = await res.text();
  if (!res.ok) {
    const snippet = raw.replace(/\s+/g, " ").slice(0, 220);
    const err = new Error(`Graph ${res.status}: ${snippet}`);
    err.status = res.status;
    throw err;
  }
  let parsed = {};
  try {
    parsed = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  return mapPage(parsed);
}

export function snapshotNotebooks(rows) {
  return (rows || [])
    .slice(0, 8)
    .map((n) => n.name)
    .filter(Boolean)
    .join("; ");
}
