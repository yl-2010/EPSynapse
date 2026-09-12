# Mac Studio commands

Sit at the Mac Studio. Not a MacBook. The live API (`https://api.epsynapse.com`) is this machine on port 3006.

`git push` only updates GitHub. Express keeps the old process until you pull and restart.

```bash
cd /Users/yanlevin/github/JYPE
git checkout main
git pull --rebase origin main
launchctl kickstart -k "gui/$(id -u)/com.jype.server"
curl -sS -f http://127.0.0.1:3006/health
curl -sS -f https://api.epsynapse.com/health
```

Both curls should print JSON with `"ok":true`.

If local `/health` fails, the LaunchAgent is not loaded. Start it by hand, then hit `/health` again:

```bash
cd /Users/yanlevin/github/JYPE
npm run server
curl -sS -f http://127.0.0.1:3006/health
```

Logs: `/tmp/jype-server.log`

Do this after anyone lands a change under `server/`. Until this restart, `api.epsynapse.com` is still the old code.

Waiting on this machine: TODO check into Completed. Pull, restart Express, then `npm run deploy:web`. Notes: [`TODO_COMPLETE.md`](TODO_COMPLETE.md).

Full startup notes: [`STARTUP.md`](STARTUP.md).
