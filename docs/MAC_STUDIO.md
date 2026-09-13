# Mac Studio commands

Sit at the Mac Studio. Not a MacBook. The live API (`https://api.epsynapse.com`) is this machine on port 3006.

`git push` only updates GitHub. Express keeps the old process until you pull and restart.

```bash
cd /Users/yanlevin/github/EPSynapse
git checkout main
git pull --rebase origin main
launchctl kickstart -k "gui/$(id -u)/com.epsynapse.server"
curl -sS -f http://127.0.0.1:3006/health
curl -sS -f https://api.epsynapse.com/health
```

Both curls should print JSON with `"ok":true`.

A Mac reboot needs no extra commands. Login starts Express and the tunnel. This `kickstart` is only for a new `server/` commit.

Logs: `/tmp/epsynapse-server.log`

Do this after anyone lands a change under `server/`. Until this restart, `api.epsynapse.com` is still the old code.

TODO checks into Completed are live. Notes: [`TODO_COMPLETE.md`](TODO_COMPLETE.md).

Full startup notes: [`STARTUP.md`](STARTUP.md).
