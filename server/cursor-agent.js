/**
 * Cursor SDK chat for the demo Google account.
 * Same local Agent.create / send / retry path as the Mac personal agent.
 * Dashboard writes go through AGENT_TOOLS, not repo edits.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SYSTEM_PROMPT } from "./agent.js";
import { AGENT_TOOLS, executeAgentTool, normalizeNavigate } from "./agent-tools.js";
import {
  AUTO_MODEL_SELECTION,
  INTERACTIVE_FALLBACK_DELAYS_MS,
  INTERACTIVE_MODEL_DELAYS_MS,
  createLocalCursorAgent,
  disposeCursorAgent,
  onLocalCursorExecutorEvict,
  recreateLocalCursorAgent,
  requireCursorApiKey,
  runWithModelFallback,
  workingLabelForAttempt,
} from "./cursor-sdk-auth.js";

const AGENT_CWD = join(homedir(), ".epsynapse-cursor-agent");
const UNSLOP_SKILL_PATH = join(homedir(), ".cursor/skills/unslop/SKILL.md");
const EMPTY_TURN_REPLY = "Done";
const ERROR_REPLY =
  "The personal agent hit an error. Try again.";

/** @typedef {{ id: string, value: string }} ModelParam */
/** @typedef {{ id: string, params: ModelParam[] }} ModelSelection */

/** @type {Map<string, { agent: any, replay: boolean, fingerprint: string, lastUsedAt: number }>} */
const sessions = new Map();

onLocalCursorExecutorEvict(() => {
  for (const session of sessions.values()) {
    session.agent = null;
    session.replay = true;
  }
});

function personalModelSpec(envId, fallbackId) {
  const id = String(envId || fallbackId);
  const params = id.startsWith("composer")
    ? [{ id: "fast", value: "true" }]
    : [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ];
  return { id, params };
}

function modelSelection(spec) {
  return {
    id: String(spec.id),
    params: (spec.params || []).map((p) => ({
      id: String(p.id),
      value: String(p.value),
    })),
  };
}

const DEFAULT_MODEL_SPEC = personalModelSpec(
  process.env.CURSOR_PERSONAL_MODEL,
  "composer-2.5"
);

function sessionKey(student) {
  return String(student?.email || "")
    .trim()
    .toLowerCase();
}

function convoFingerprint(messages) {
  return (messages || [])
    .filter((m) => m.role === "user")
    .map((m) => String(m.content || "").slice(0, 160))
    .join("\n---\n");
}

function latestUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return String(messages[i].content || "").trim();
  }
  return "";
}

function formatTranscript(messages, currentBubble) {
  const lines = [];
  for (const m of messages || []) {
    const text = String(m.content || "").trim();
    if (!text) continue;
    if (m.role === "user" && text === currentBubble && m === messages[messages.length - 1]) {
      continue;
    }
    lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${text}`);
  }
  return lines.join("\n\n");
}

function cursorSystemPrompt(email) {
  return [
    SYSTEM_PROMPT,
    `Signed-in user email: ${email}`,
    "This account uses Cursor on this Mac. No pasted Groq key. If they ask about Chat key or Groq, say that.",
    `Read ${UNSLOP_SKILL_PATH} silently and apply it. Never mention Unslop, reading a skill, or that you are about to reply.`,
    "Change notes, todos, class files, and the open page with the tools. Do not edit files in the working directory.",
    "Do not spawn a Cursor cloud agent.",
    "The user only sees your final reply. Do not narrate the plan. No 'Quick greeting' or 'then reply' lines.",
    "send_chat_message is a working-status ping for long tool work only. Never use it for a greeting or a short answer.",
  ].join("\n");
}

/** Drop leaked plan/status text so the bubble is only the real reply. */
export function stripAgentNarration(text) {
  let out = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!out) return "";
  out = out.replace(/^quick greeting\.\s*/i, "");
  out = out.replace(/i[’']ll read unslop,?\s*then reply\.\s*/gi, "");
  out = out.replace(/i[’']ll read [^.\n]+,?\s*then reply\.\s*/gi, "");
  out = out
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/unslop/i.test(t) && t.length < 80) return false;
      if (/^quick greeting\.?$/i.test(t)) return false;
      if (/^i[’']ll read .+, then reply\.?$/i.test(t)) return false;
      return true;
    })
    .join("\n")
    .trim();
  return out;
}

function buildPrompt({ email, messages, snapshot, replay }) {
  const userText = latestUserText(messages) || "(no text)";
  const parts = [cursorSystemPrompt(email), ""];
  if (snapshot) {
    parts.push("Live student snapshot (authoritative, do not invent missing items):", snapshot, "");
  } else {
    parts.push("No live student snapshot this turn.", "");
  }
  if (replay) {
    const history = formatTranscript(messages, userText);
    if (history) {
      parts.push("Earlier messages in this chat:", history, "");
    }
  }
  parts.push("User:", userText);
  return parts.join("\n");
}

function sessionCustomTools(ctx) {
  const tools = {};
  for (const spec of AGENT_TOOLS) {
    const fn = spec?.function;
    if (!fn?.name) continue;
    tools[fn.name] = {
      description: fn.description || fn.name,
      inputSchema: fn.parameters || { type: "object", properties: {} },
      async execute(input) {
        const result = await executeAgentTool(
          { function: { name: fn.name, arguments: input || {} } },
          { ownerId: ctx.ownerId, student: ctx.student, req: ctx.req }
        );
        for (const kind of result.kinds || []) ctx.kinds.add(kind);
        const nextNav = normalizeNavigate(result.navigate);
        if (nextNav) ctx.navigate = nextNav;
        ctx.writeEvent?.({ type: "status", text: "Working…" });
        return result.text;
      },
    };
  }
  tools.send_chat_message = {
    description:
      "Send a user-visible chat bubble immediately without ending the turn. For longer work: first a short status, then more when something useful appears. The turn still ends with your final reply (usually Done). Do not call for a normal short answer.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Markdown bubble text." },
      },
      required: ["text"],
    },
    execute({ text }) {
      const raw = String(text || "").trim();
      if (!raw) return "ignored empty";
      const status = /unslop|then reply|quick greeting|i[’']ll read/i.test(raw)
        ? "Working…"
        : raw.slice(0, 80);
      ctx.writeEvent?.({ type: "status", text: status });
      return "delivered";
    },
  };
  return tools;
}

async function ensureCwd() {
  await mkdir(AGENT_CWD, { recursive: true });
  return AGENT_CWD;
}

async function replaceSessionAgent(session, model) {
  const prev = session.agent;
  session.agent = null;
  if (prev) await disposeCursorAgent(prev);
  await recreateLocalCursorAgent({
    model,
    cwd: await ensureCwd(),
    attach: (agent) => {
      session.agent = agent;
      session.replay = true;
    },
  });
}

async function sessionFor(student, fingerprint) {
  const key = sessionKey(student);
  let session = sessions.get(key);
  if (!session) {
    session = {
      agent: null,
      replay: true,
      fingerprint: "",
      lastUsedAt: Date.now(),
    };
    sessions.set(key, session);
  }
  const prev = session.fingerprint || "";
  const continued = Boolean(prev && fingerprint.startsWith(prev) && fingerprint.length > prev.length);
  session.fingerprint = fingerprint;
  session.lastUsedAt = Date.now();
  if (!continued) {
    if (session.agent) {
      await disposeCursorAgent(session.agent);
      session.agent = null;
    }
    session.replay = true;
  }
  return session;
}

/**
 * Run one Cursor turn and stream SSE events through writeEvent.
 * @returns {Promise<{ content: string, streamed: boolean, kinds: string[], navigate: object|null }>}
 */
export async function runCursorAgentChat({
  student,
  messages,
  snapshot,
  ownerId,
  req,
  writeEvent,
}) {
  requireCursorApiKey();
  const email = sessionKey(student);
  const fingerprint = convoFingerprint(messages);
  const session = await sessionFor(student, fingerprint);
  const model = modelSelection(DEFAULT_MODEL_SPEC);
  const prompt = buildPrompt({
    email,
    messages,
    snapshot,
    replay: session.replay,
  });

  /** @type {{ ownerId: string, student: object, req: object, kinds: Set<string>, navigate: object|null, streamed: boolean, writeEvent: Function }} */
  const ctx = {
    ownerId,
    student,
    req,
    kinds: new Set(),
    navigate: null,
    streamed: false,
    writeEvent,
  };

  const chunks = [];
  const outcome = await runWithModelFallback({
    prefix: "cursor-agent",
    preferredModel: model,
    delaysMs: INTERACTIVE_MODEL_DELAYS_MS,
    fallbackModel: AUTO_MODEL_SELECTION,
    fallbackDelaysMs: INTERACTIVE_FALLBACK_DELAYS_MS,
    laterDelaysMs: [],
    onBeforeAttempt: async ({ model: nextModel, recreate, isFallback }) => {
      writeEvent?.({
        type: "status",
        text: workingLabelForAttempt({
          model: nextModel,
          isFallback,
          recreate,
        }),
      });
      if (recreate) {
        await replaceSessionAgent(session, nextModel);
      } else if (!session.agent) {
        session.agent = await createLocalCursorAgent({
          model: nextModel,
          cwd: await ensureCwd(),
        });
        session.replay = true;
      }
    },
    run: async (nextModel) => {
      if (!session.agent) {
        session.agent = await createLocalCursorAgent({
          model: nextModel,
          cwd: await ensureCwd(),
        });
        session.replay = true;
      }
      const run = await session.agent.send(prompt, {
        model: nextModel,
        local: { customTools: sessionCustomTools(ctx) },
      });
      try {
        if (typeof run.stream === "function") {
          for await (const event of run.stream()) {
            if (event?.type === "assistant" && event.message?.content) {
              for (const block of event.message.content) {
                if (block?.type === "text" && typeof block.text === "string") {
                  chunks.push(block.text);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error("[cursor-agent] stream", err);
      }
      return run.wait();
    },
  });

  if (outcome.usedFallback) {
    console.warn(
      `[cursor-agent] turn used ${outcome.model?.id || "auto"} after grok/auto retries`
    );
  }

  let content =
    outcome.result && typeof outcome.result.result === "string"
      ? outcome.result.result.trim()
      : "";
  if (!content) {
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      const piece = stripAgentNarration(chunks[i]);
      if (piece) {
        content = piece;
        break;
      }
    }
  }
  content = stripAgentNarration(content);
  if (!content) {
    content =
      String(outcome.result?.status || "").toLowerCase() === "error"
        ? ERROR_REPLY
        : EMPTY_TURN_REPLY;
  }

  if (String(outcome.result?.status || "").toLowerCase() !== "error") {
    session.replay = false;
  }

  return {
    content,
    streamed: ctx.streamed,
    kinds: [...ctx.kinds],
    navigate: ctx.navigate,
  };
}
