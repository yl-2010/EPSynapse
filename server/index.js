/**
 * JYPE / EPSynapse Mac Express API.
 * Pattern matches SocketHR / NoteLMs / yanylevin: Cloudflare Tunnel to this process.
 *
 * Port 3006 — public hostname api.epsynapse.com (own tunnel).
 */

import express from "express";
import cors from "cors";

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

app.listen(PORT, HOST, () => {
  console.log(`[jype-server] listening on http://${HOST}:${PORT}`);
});
