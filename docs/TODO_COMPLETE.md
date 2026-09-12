# Pickup: TODO check into Completed

Work stopped on a Windows laptop (Prasham). The code is on `main`. It is not live until someone on the Mac Studio pulls, restarts Express, and deploys the site.

The TODO bubble used to do nothing. Clicking it now marks the row done and slides it into Completed.

## What landed

Web (`app.js`, `styles.css`, `index.html`, `404.html`)

- The bubble is a real `<button class="edu-check">` with `data-todo-id`.
- Click on `#edu-app` calls `completeTodoRow`. Title links still open Canvas.
- The row FLIP-animates into the Completed list (about 0.48s). No full dashboard remount.
- Optimistic `item.done = true`. If Canvas write fails, the row stays completed for the demo.
- Cache bust: `styles.css?v=todo2` and `app.js?v=todo2`. Keep `theme-orb.js?v=moon5`.

API (`server/canvas.js`, `server/index.js`)

- `POST /v1/me/canvas/assignments/:id/complete`
- `markAssignmentComplete` writes a Canvas planner override (`marked_complete`).
- Assignments now carry `plannerOverrideId` and `plannableType`.

iOS (`Panels.swift`, `DashboardStore.swift`, `Models.swift`)

- The bubble is a `Button`. `markDone` sets `done` inside `withAnimation(.spring)`.
- Then it POSTs the same complete route.

Earlier, related: HW/QA/MA filter chips update in place (`paintAssignmentFilters`). Do not go back to `routeAndRender` on a chip or checkbox click. That remount grows the glass panels.

## Do this on the Mac Studio

```bash
cd /Users/yanlevin/github/JYPE
git checkout main
git pull --rebase origin main
launchctl kickstart -k "gui/$(id -u)/com.jype.server"
curl -sS -f http://127.0.0.1:3006/health
curl -sS -f https://api.epsynapse.com/health
npm run deploy:web
```

Then open https://epsynapse.com, hard-refresh, sign in, and click a TODO bubble. The row should move into Completed. The title should still open Canvas.

If `git pull --rebase` conflicts on `index.html` or `404.html`, those are cache-bust tags. Keep `styles.css?v=todo2` and `app.js?v=todo2`. Keep `theme-orb.js?v=moon5`. Do not throw away teammate HTML around those lines.

## Do not

- Do not remount the dashboard to complete a row.
- Do not start Express from a laptop. Port 3006 lives on this Mac.
- Do not run `vercel git connect`.
- The Windows machine cannot run `npm run deploy:web` (no bash / no `~/.config/jype/vercel.env`). That is why the site is still old.

Restart notes: [MAC_STUDIO.md](MAC_STUDIO.md).
