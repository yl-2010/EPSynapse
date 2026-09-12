#!/usr/bin/env node
/**
 * Stdio MCP for school OneNote. Same Office public client as the Express API.
 * Token cache: ~/.config/jype/onenote-mcp-token.json
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  OFFICE_CLIENT_ID,
  EPS_TENANT_ID,
  startDeviceCode,
  pollDeviceCode,
  refreshAccessToken,
} from "./onedrive.js";
import {
  createPage,
  getPage,
  listNotebooks,
  listPages,
  listSections,
  onenoteError,
} from "./onenote.js";

const TOKEN_PATH =
  process.env.ONENOTE_TOKEN_STORE_PATH ||
  join(homedir(), ".config", "jype", "onenote-mcp-token.json");

const TOOLS = [
  {
    name: "authenticate",
    description: "Start school Microsoft device-code sign-in for OneNote. Prints a URL and code.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_notebooks",
    description: "List OneNote notebooks for the signed-in school account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_sections",
    description: "List sections in a notebook, or all sections if notebookId is omitted.",
    inputSchema: {
      type: "object",
      properties: { notebookId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "list_pages",
    description: "List pages in a section, or search pages by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        sectionId: { type: "string" },
        q: { type: "string", description: "Search titles and content" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_page",
    description: "Read one OneNote page as text (and HTML).",
    inputSchema: {
      type: "object",
      properties: { pageId: { type: "string" } },
      required: ["pageId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_page",
    description: "Create a page in a section. Pass title plus text or HTML.",
    inputSchema: {
      type: "object",
      properties: {
        sectionId: { type: "string" },
        title: { type: "string" },
        text: { type: "string" },
        html: { type: "string" },
      },
      required: ["sectionId", "title"],
      additionalProperties: false,
    },
  },
];

async function loadToken() {
  try {
    const raw = JSON.parse(await readFile(TOKEN_PATH, "utf8"));
    if (!raw?.accessToken) return null;
    return raw;
  } catch {
    return null;
  }
}

async function saveToken(bag) {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(
    TOKEN_PATH,
    JSON.stringify(
      {
        accessToken: bag.accessToken || "",
        refreshToken: bag.refreshToken || "",
        exp: bag.exp || 0,
        email: bag.email || "",
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

async function accessToken() {
  const envTok = String(process.env.ONENOTE_ACCESS_TOKEN || process.env.GRAPH_ACCESS_TOKEN || "").trim();
  if (envTok) return envTok;
  let bag = await loadToken();
  if (!bag?.accessToken) {
    throw new Error("Not signed in. Call authenticate first.");
  }
  const exp = Number(bag.exp) || 0;
  if (exp * 1000 <= Date.now() + 90_000) {
    const refreshed = await refreshAccessToken(bag.refreshToken);
    if (!refreshed.ok) throw new Error(refreshed.error || "OneNote token expired. Call authenticate.");
    bag = { ...bag, ...refreshed };
    await saveToken(bag);
  }
  return bag.accessToken;
}

async function authenticate() {
  const started = await startDeviceCode();
  if (!started.ok) {
    throw new Error(started.error || "Microsoft would not start OneNote sign-in.");
  }
  const url = started.verification_uri_complete || started.verification_uri;
  const message = [
    started.message || `Open ${url} and enter ${started.user_code}`,
    `URL: ${url}`,
    `Code: ${started.user_code}`,
  ].join("\n");
  process.stderr.write(`${message}\n`);

  const deadline = Number(started.expiresAt) || Date.now() + 900_000;
  const intervalMs = Math.max(3, Number(started.interval) || 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const poll = await pollDeviceCode(started.device_code, started.clientId || OFFICE_CLIENT_ID);
    if (poll.ok) {
      await saveToken(poll);
      return `Signed in as ${poll.email || "school Microsoft"}. Token saved.`;
    }
    if (poll.pending || poll.error === "authorization_pending" || poll.error === "slow_down") {
      continue;
    }
    throw new Error(poll.error || "Microsoft sign-in failed.");
  }
  throw new Error("Microsoft sign-in timed out.");
}

async function callTool(name, input = {}) {
  if (name === "authenticate") return authenticate();
  const token = await accessToken();
  switch (name) {
    case "list_notebooks":
      return listNotebooks(token);
    case "list_sections":
      return listSections(token, input.notebookId);
    case "list_pages":
      return listPages(token, {
        sectionId: input.sectionId,
        q: input.q,
        limit: input.limit,
      });
    case "get_page":
      return getPage(token, input.pageId);
    case "create_page":
      return createPage(token, {
        sectionId: input.sectionId,
        title: input.title,
        text: input.text,
        html: input.html,
      });
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(message) } })}\n`
  );
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "onenote", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "ping") return reply(id, {});
  if (method === "tools/call") {
    const name = String(params?.name || "");
    try {
      const data = await callTool(name, params?.arguments || {});
      const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      return reply(id, { content: [{ type: "text", text }] });
    } catch (err) {
      const text = onenoteError(err);
      return reply(id, {
        content: [{ type: "text", text }],
        isError: true,
      });
    }
  }
  if (id !== undefined) replyError(id, `Unknown method ${method}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const raw = String(line || "").trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  handle(msg).catch((err) => {
    if (msg?.id !== undefined) replyError(msg.id, err?.message || String(err));
  });
});

void EPS_TENANT_ID;
