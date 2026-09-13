# Start everything (Mac Studio + epsynapse.com API)

Copy-paste card for the person at the Mac Studio: [`MAC_STUDIO.md`](MAC_STUDIO.md).

Production site (**https://epsynapse.com**) is on Vercel. The Mac exposes the Express API on port **3006** through a dedicated Cloudflare Tunnel (**https://api.epsynapse.com**).

---

## Pick up a server change (do this on the Mac Studio)

`git push` updates GitHub. It does not restart Express. The site can be new while `api.epsynapse.com` is still the old process. That is why grades were missing or stuck at 0%.

Sit at the Mac Studio. Not a MacBook. Terminal:

```bash
cd /Users/yanlevin/github/JYPE
git checkout main
git pull --rebase origin main
launchctl kickstart -k "gui/$(id -u)/com.jype.server"
curl -sS -f http://127.0.0.1:3006/health
curl -sS -f https://api.epsynapse.com/health
```

Both curls should print JSON with `"ok":true`.

Logs if something looks wrong: `/tmp/jype-server.log`.

Do this after anyone lands a change under `server/`. Until this restart, the live API will not have it.

---

## After a Mac restart

Nothing to start. Login loads `com.jype.server` and `com.jype.cloudflared` (`RunAtLoad` + `KeepAlive`), same as the other APIs on this Mac. FileVault unlock is the only prompt.

Optional check:

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

First time on a Mac, or if they vanished from Login Items:

```bash
bash /Users/yanlevin/github/JYPE/deploy/launchagents/install.sh
```

That copies the plists, `launchctl enable`s them, and bootstraps if they are not already loaded. Do not run it to pick up `server/` code. Use `kickstart` above for that.

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
