# Start everything (Mac Studio + epsynapse.com API)

Production site (**https://epsynapse.com**) is on Vercel. The Mac exposes the Express API on port **3006** through a dedicated Cloudflare Tunnel (**https://api.epsynapse.com**).

---

## After a Mac restart

LaunchAgents auto-start the JYPE API + tunnel on login.

```bash
curl -sS http://127.0.0.1:3006/health
curl -sS https://api.epsynapse.com/health
```

### LaunchAgents on this Mac

| Label | What |
|-------|------|
| `com.jype.server` | JYPE Express `:3006` |
| `com.jype.cloudflared` | Tunnel → `api.epsynapse.com` |

Plists live in `~/Library/LaunchAgents/`. Other apps on this Mac keep their own pairs. Do not merge tunnels.

Install / reload:

```bash
cp /Users/yanlevin/github/JYPE/deploy/launchagents/com.jype.server.plist ~/Library/LaunchAgents/
cp /Users/yanlevin/github/JYPE/deploy/launchagents/com.jype.cloudflared.plist ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.jype.server.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.jype.cloudflared.plist
```

If they are already loaded: `launchctl kickstart -k "gui/$(id -u)/com.jype.server"` (same for `com.jype.cloudflared`).

Logs: `/tmp/jype-server.log`, `/tmp/cloudflared-jype.log`.

Git auto-deploy is off. After any browser-facing change (`index.html`, `styles.css`, `app.js`, `chatbot.js`, `liquid-glass.js`, `theme-orb.js`, `runtime-config.json`, `vercel.json`, root static files), agents must run `npm run deploy:web` and confirm https://epsynapse.com shows the new page. `git push` does not update the live site.

---

## Manual start (only if LaunchAgents are not installed)

### Terminal 1 — API

```bash
cd /Users/yanlevin/github/JYPE
npm run server
```

### Terminal 2 — Tunnel

```bash
cloudflared tunnel --config ~/.cloudflared/config-jype.yml run
```

First-time tunnel setup: [`deploy/cloudflared/README.md`](../deploy/cloudflared/README.md).

---

## Ports (this Mac)

| Port | Service | Public? |
|------|---------|---------|
| 3000 | SocketHR Express | via `api.sockethr.com` |
| 3002 | NoteLMs Express | via `api.notelms.com` |
| 3004 | another local API | leave this port alone |
| 3006 | JYPE Express | via `api.epsynapse.com` |
| 1234 | LM Studio | **never** (localhost only) |
