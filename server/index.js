/**
 * JYPE / EPSynapse Mac Express API.
 * Pattern matches SocketHR / NoteLMs / yanylevin: Cloudflare Tunnel to this process.
 *
 * Port 3006 — public hostname api.epsynapse.com (own tunnel).
 */

import express from "express";
import cors from "cors";
import {
  PROVIDERS,
  explainUpstreamError,
  publicAgentConfig,
  resolveApiKey,
  sanitizeMessages,
  upstreamBody,
  upstreamHeaders,
} from "./agent.js";

const PORT = Number(process.env.PORT || 3006);
const HOST = process.env.HOST || "0.0.0.0";
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (!allowed.length || allowed.includes("*") || allowed.includes(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "jype-server",
    time: new Date().toISOString(),
  });
});

app.get("/v1/agent/config", (_req, res) => {
  res.json(publicAgentConfig());
});

app.post("/v1/agent/chat", async (req, res) => {
  const providerId = String(req.body?.provider || "groq");
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return res.status(400).json({ error: "Unknown provider." });
  }

  const messages = sanitizeMessages(req.body?.messages);
  if (!messages.length) {
    return res.status(400).json({ error: "Send at least one user message." });
  }

  const { key, source } = resolveApiKey(req, providerId);
  if (!key) {
    return res.status(401).json({
      error:
        "Paste a free API key first. Groq is the fastest signup: console.groq.com/keys",
    });
  }

  let upstream;
  try {
    upstream = await fetch(provider.url, {
      method: "POST",
      headers: upstreamHeaders(provider, key),
      body: JSON.stringify(upstreamBody(provider, messages)),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    const timedOut = err && err.name === "TimeoutError";
    return res.status(502).json({
      error: timedOut ? "The model timed out. Try again." : "Could not reach the model host.",
    });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return res.status(upstream.status === 401 ? 401 : 502).json({
      error: explainUpstreamError(upstream.status, text),
    });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Agent-Source", source);
  res.setHeader("X-Agent-Provider", provider.id);
  res.flushHeaders?.();

  if (!upstream.body) {
    return res.end();
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // Client hung up or the upstream stream died. Fine.
  } finally {
    reader.releaseLock();
    res.end();
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[jype-server] listening on http://${HOST}:${PORT}`);
});
