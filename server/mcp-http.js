/**
 * Remote MCP server for EPSynapse. Streamable HTTP transport at POST /mcp.
 *
 * External MCP clients (Perplexity, Claude, Cursor) connect with the student's
 * session id as a bearer token and get the same tools the in-app chatbot uses
 * (server/agent-tools.js), plus connection_status. Every call runs as the
 * signed-in student.
 *
 * Auth model for the hackathon: the bearer token is the EPSynapse session id.
 * Students copy it from GET /v1/me/mcp (Settings > MCP in the web app).
 * No OAuth authorization server yet. See docs/MCP.md.
 */

import { randomBytes } from "node:crypto";
import { AGENT_TOOLS, executeAgentTool } from "./agent-tools.js";
import { ownerIdForStudent } from "./chat-history.js";
import { studioFlags } from "./studio-ms.js";
import {
  COOKIE as SESSION_COOKIE,
  HEADER as SESSION_HEADER,
  publicProfile,
  studentFromRequest,
} from "./students.js";
import { adminConsentUrl } from "./teams.js";

const SERVER_NAME = "epsynapse";
const SERVER_VERSION = "0.1.0";
const LATEST_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLIC_BASE = String(process.env.PUBLIC_API_BASE || "https://api.epsynapse.com").replace(/\/+$/, "");
const MCP_URL = `${PUBLIC_BASE}/mcp`;
const SIGN_IN_HINT =
  "Sign in at https://epsynapse.com, open Settings > MCP, and paste the connect token.";
const APPROVAL_SENTENCE = "School IT has to approve EPSynapse once.";

// Dashboard-only tools that mean nothing outside the web app.
const HIDDEN_TOOLS = new Set(["open_page"]);

// Which Microsoft service each agent tool depends on.
const TOOL_SERVICE = {
  list_onedrive_files: "onedrive",
  read_onedrive_file: "onedrive",
  write_onedrive_file: "onedrive",
  list_onenote_notebooks: "onenote",
  list_onenote_sections: "onenote",
  list_onenote_pages: "onenote",
  read_onenote_page: "onenote",
  create_onenote_page: "onenote",
  list_outlook_mail: "outlook",
  read_outlook_mail: "outlook",
  send_outlook_mail: "outlook",
  list_outlook_events: "outlook",
  list_teams_chats: "teams",
  read_teams_thread: "teams",
  send_teams_message: "teams",
};

const SERVICE_LABEL = {
  canvas: "Canvas",
  onedrive: "OneDrive",
  onenote: "OneNote",
  outlook: "Outlook",
  teams: "Teams",
};

// student.msServices holds per-scope probe results (files, notes, mail, chats).
// A false value means Microsoft denied that scope for this account.
const SERVICE_KEYS = {
  onedrive: ["files", "onedrive"],
  onenote: ["notes", "onenote"],
  outlook: ["mail", "outlook"],
  teams: ["chats", "teams"],
};

const CONNECTION_STATUS_TOOL = {
  name: "connection_status",
  description:
    "Show which EPSynapse services this student has connected (Canvas, OneDrive, OneNote, Outlook, Teams) and what to do about any that are missing or blocked by school IT.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const MCP_TOOLS = [
  ...AGENT_TOOLS.filter((t) => t?.function?.name && !HIDDEN_TOOLS.has(t.function.name)).map((t) => ({
    name: t.function.name,
    description: String(t.function.description || ""),
    inputSchema: t.function.parameters || { type: "object", properties: {} },
  })),
  CONNECTION_STATUS_TOOL,
];
const TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));

// MCP session id -> { studentKey, email, protocolVersion, createdAt, lastSeen }
const mcpSessions = new Map();

function sweepSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, rec] of mcpSessions) {
    if ((rec.lastSeen || rec.createdAt || 0) < cutoff) mcpSessions.delete(id);
  }
}

function newSessionId() {
  return randomBytes(24).toString("hex");
}

/* ---------- auth ---------- */

function bearerToken(req) {
  const raw = String(req.get?.("authorization") || req.headers?.authorization || "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1].trim() : "";
}

async function studentFromAny(req) {
  const bearer = bearerToken(req);
  if (bearer) {
    const shim = { headers: { [SESSION_HEADER]: bearer } };
    const student = await studentFromRequest(shim);
    if (student) return { student, sid: bearer };
  }
  const student = await studentFromRequest(req);
  if (!student) return null;
  const sid =
    String(req.get?.(SESSION_HEADER) || req.headers?.[SESSION_HEADER] || "").trim() ||
    cookieSid(req);
  return { student, sid };
}

function cookieSid(req) {
  const header = String(req.headers?.cookie || "");
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return "";
}

function unauthorized(res) {
  res.set("WWW-Authenticate", `Bearer realm="EPSynapse", resource_metadata="${PUBLIC_BASE}/.well-known/oauth-protected-resource"`);
  return res.status(401).json({ error: SIGN_IN_HINT });
}

/* ---------- service state ---------- */

// Returns the denial sentence for a service, or "" when it is not denied.
// Prefers publicMe().msDenied (set by the Microsoft auth routes), then falls
// back to raw student.msServices flags.
function deniedReason(student, me, service) {
  const fromMe = me?.msDenied && typeof me.msDenied === "object" ? me.msDenied[service] : "";
  if (fromMe) return String(fromMe);
  const bag = student?.msServices;
  if (bag && typeof bag === "object" && SERVICE_KEYS[service].some((k) => bag[k] === false)) {
    return `Microsoft denied ${SERVICE_LABEL[service]} access for this account.`;
  }
  return "";
}

function serviceState(student, publicMe) {
  const me = publicMe(student);
  const studio = studioFlags(student);
  const state = {
    canvas: { connected: Boolean(me.canvasConnected), denied: "" },
    onedrive: {
      connected: Boolean(me.onedriveConnected || studio.onedrive),
      denied: deniedReason(student, me, "onedrive"),
    },
    onenote: {
      connected: Boolean(me.onenoteConnected ?? me.onedriveConnected) || Boolean(studio.onenote),
      denied: deniedReason(student, me, "onenote"),
    },
    outlook: {
      connected: Boolean(me.outlookConnected || studio.outlook),
      denied: deniedReason(student, me, "outlook"),
    },
    teams: {
      connected: Boolean(me.teamsConnected || studio.teams),
      denied: deniedReason(student, me, "teams"),
    },
  };
  for (const s of Object.values(state)) if (s.denied) s.connected = false;
  return state;
}

function deniedMessage(service, reason) {
  const base = reason || `${SERVICE_LABEL[service]} is blocked for this account.`;
  const withApproval = /approve/i.test(base) ? base : `${base} ${APPROVAL_SENTENCE}`;
  return `${withApproval} Approval link: ${adminConsentUrl()}`;
}

function connectionStatus(student, publicMe) {
  const state = serviceState(student, publicMe);
  const anyDenied = Object.values(state).some((s) => s.denied);
  const services = {};
  for (const [key, s] of Object.entries(state)) {
    services[key] = {
      label: SERVICE_LABEL[key],
      connected: s.connected,
      ...(s.denied
        ? { denied: true, reason: s.denied, adminConsentUrl: adminConsentUrl(), note: APPROVAL_SENTENCE }
        : {}),
    };
  }
  const missing = Object.entries(state)
    .filter(([, s]) => !s.connected && !s.denied)
    .map(([k]) => SERVICE_LABEL[k]);
  const out = {
    student: student.email || "",
    services,
    ...(missing.length
      ? { howToConnect: `Connect ${missing.join(", ")} at https://epsynapse.com under Settings.` }
      : {}),
    ...(anyDenied ? { adminConsentUrl: adminConsentUrl(), note: APPROVAL_SENTENCE } : {}),
  };
  return out;
}

/* ---------- JSON-RPC helpers ---------- */

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
}

function isRequest(msg) {
  return (
    msg &&
    typeof msg === "object" &&
    !Array.isArray(msg) &&
    msg.jsonrpc === "2.0" &&
    typeof msg.method === "string"
  );
}

function hasId(msg) {
  return msg && msg.id !== undefined && msg.id !== null;
}

function toolResultFromAgent(result) {
  const text = String(result?.text ?? "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.error === "string" && Object.keys(parsed).length === 1) {
    return { content: [{ type: "text", text: parsed.error }], isError: true };
  }
  const out = { content: [{ type: "text", text }] };
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.structuredContent = parsed;
  return out;
}

/* ---------- method handlers ---------- */

async function handleMessage(msg, ctx) {
  const { student, publicMe, req } = ctx;
  const id = msg.id;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion || "");
      const protocolVersion = SUPPORTED_PROTOCOLS.has(asked) ? asked : LATEST_PROTOCOL;
      const sessionId = newSessionId();
      mcpSessions.set(sessionId, {
        studentKey: ownerIdForStudent(student),
        email: student.email || "",
        protocolVersion,
        createdAt: Date.now(),
        lastSeen: Date.now(),
      });
      ctx.newSessionId = sessionId;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: `You are connected to ${student.email || "a student"}'s EPSynapse account. Call connection_status first if a school service tool fails.`,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: MCP_TOOLS });
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    case "tools/call": {
      const name = String(params.name || "").trim();
      const args = params.arguments;
      if (!name || !TOOL_NAMES.has(name)) {
        return rpcError(id, -32602, `Unknown tool: ${name || "(none)"}`);
      }
      if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
        return rpcError(id, -32602, "arguments must be an object");
      }
      console.log(`[mcp] tools/call ${name} ${student.email || "(no email)"}`);

      if (name === "connection_status") {
        const status = connectionStatus(student, publicMe);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          structuredContent: status,
        });
      }

      const service = TOOL_SERVICE[name];
      const denied = service ? serviceState(student, publicMe)[service].denied : "";
      if (denied) {
        return rpcResult(id, {
          content: [{ type: "text", text: deniedMessage(service, denied) }],
          isError: true,
        });
      }

      const ownerId = ownerIdForStudent(student);
      const result = await executeAgentTool(
        { name, arguments: args || {} },
        { ownerId, student, req }
      );
      return rpcResult(id, toolResultFromAgent(result));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

async function processOne(msg, ctx) {
  if (!isRequest(msg)) {
    return rpcError(hasId(msg) ? msg.id : null, -32600, "Invalid Request");
  }
  if (!hasId(msg)) {
    // Notification. notifications/initialized, notifications/cancelled, etc.
    return null;
  }
  try {
    return await handleMessage(msg, ctx);
  } catch (err) {
    return rpcError(msg.id, -32000, String(err?.message || "Server error"));
  }
}

/* ---------- transport ---------- */

function wantsSseOnly(req) {
  const accept = String(req.get?.("accept") || "").toLowerCase();
  return accept.includes("text/event-stream") && !accept.includes("application/json") && !accept.includes("*/*");
}

function sendRpc(req, res, status, payload) {
  if (wantsSseOnly(req)) {
    res.status(status);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "close",
    });
    res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    return res.end();
  }
  return res.status(status).json(payload);
}

function mcpCors(_req, res, next) {
  res.set("Access-Control-Allow-Origin", "*");
  res.removeHeader("Access-Control-Allow-Credentials");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept, x-epsynapse-session"
  );
  res.set("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate");
  res.set("Access-Control-Max-Age", "86400");
  next();
}

function connectPayload(sid) {
  const header = `Authorization: Bearer ${sid}`;
  const headers = { Authorization: `Bearer ${sid}` };
  return {
    url: MCP_URL,
    token: sid,
    header,
    transport: "streamable-http",
    perplexityJson: {
      name: "EPSynapse",
      url: MCP_URL,
      headers,
    },
    claudeJson: {
      mcpServers: { epsynapse: { url: MCP_URL, headers } },
    },
    cursorJson: {
      mcpServers: { epsynapse: { url: MCP_URL, headers } },
    },
    curl: `curl -s ${MCP_URL} -H '${header}' -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    note: "The token is your EPSynapse session id. Signing out of the web app revokes it.",
  };
}

/**
 * Mount the MCP routes on an existing Express app.
 * deps.publicMe(student) should return the same shape /v1/me returns. Falls
 * back to publicProfile from students.js.
 */
export function mountMcp(app, deps = {}) {
  const publicMe = typeof deps.publicMe === "function" ? deps.publicMe : publicProfile;

  const sweeper = setInterval(sweepSessions, 15 * 60 * 1000);
  if (typeof sweeper.unref === "function") sweeper.unref();

  app.use("/mcp", mcpCors);

  app.options("/mcp", (_req, res) => res.sendStatus(204));

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: MCP_URL,
      authorization_servers: [],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://github.com/yl-2010/JYPE/blob/main/docs/MCP.md",
    });
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource: MCP_URL,
      authorization_servers: [],
      bearer_methods_supported: ["header"],
    });
  });

  app.get("/v1/me/mcp", async (req, res) => {
    try {
      const auth = await studentFromAny(req);
      if (!auth?.student) return unauthorized(res);
      if (!auth.sid) {
        return res.status(400).json({ error: "No session id on this request." });
      }
      return res.json(connectPayload(auth.sid));
    } catch (err) {
      return res.status(500).json({ error: String(err?.message || "Request failed.") });
    }
  });

  app.get("/mcp", (_req, res) => {
    res.set("Allow", "POST, DELETE, OPTIONS");
    return res.status(405).json({ error: "Use POST /mcp. This server does not open a standalone SSE stream." });
  });

  app.delete("/mcp", async (req, res) => {
    const auth = await studentFromAny(req).catch(() => null);
    if (!auth?.student) return unauthorized(res);
    const sessionId = String(req.get("mcp-session-id") || "").trim();
    if (sessionId) mcpSessions.delete(sessionId);
    return res.status(200).json({ ok: true });
  });

  app.post("/mcp", async (req, res) => {
    let auth;
    try {
      auth = await studentFromAny(req);
    } catch {
      auth = null;
    }
    if (!auth?.student) return unauthorized(res);
    const { student } = auth;

    sweepSessions();
    const sessionId = String(req.get("mcp-session-id") || "").trim();
    if (sessionId) {
      const rec = mcpSessions.get(sessionId);
      if (!rec) {
        // Spec: unknown or expired session -> 404, client re-initializes.
        return sendRpc(req, res, 404, rpcError(null, -32000, "Unknown or expired Mcp-Session-Id. Send initialize again."));
      }
      if (rec.studentKey !== ownerIdForStudent(student)) {
        return sendRpc(req, res, 404, rpcError(null, -32000, "Mcp-Session-Id belongs to a different account."));
      }
      rec.lastSeen = Date.now();
    }

    const body = req.body;
    const isBatch = Array.isArray(body);
    const messages = isBatch ? body : [body];
    if (!messages.length || (!isBatch && (!body || typeof body !== "object"))) {
      return sendRpc(req, res, 400, rpcError(null, -32600, "Invalid Request"));
    }

    const ctx = { student, publicMe, req, newSessionId: "" };
    const responses = [];
    for (const msg of messages) {
      const out = await processOne(msg, ctx);
      if (out) responses.push(out);
    }

    if (ctx.newSessionId) res.set("Mcp-Session-Id", ctx.newSessionId);
    const proto = String(req.get("mcp-protocol-version") || "").trim();
    if (proto && SUPPORTED_PROTOCOLS.has(proto)) res.set("Mcp-Protocol-Version", proto);

    if (!responses.length) {
      // Only notifications or responses in the body.
      return res.status(202).end();
    }
    return sendRpc(req, res, 200, isBatch ? responses : responses[0]);
  });

  console.log(`[mcp] mounted at /mcp with ${MCP_TOOLS.length} tools`);
  return { tools: MCP_TOOLS.length };
}

export { MCP_TOOLS };
