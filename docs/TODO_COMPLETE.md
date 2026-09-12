# Pickup: TODO check into Completed

Done on the Mac Studio. Express was restarted. The site was deployed. Clicking a TODO bubble on https://epsynapse.com moves the row into Completed.

Title links that Canvas returns as `/courses/...` now get the school host prefixed, so they open Canvas instead of epsynapse.com.

## What landed

Web (`app.js`, `styles.css`, `index.html`, `404.html`)

- The bubble is a real `<button class="edu-check">` with `data-todo-id`.
- Click on `#edu-app` calls `completeTodoRow`. Title links still open Canvas.
- The row FLIP-animates into the Completed list (about 0.48s). No full dashboard remount.
- Optimistic `item.done = true`. If Canvas write fails, the row stays completed for the demo.
- Cache bust: `styles.css?v=cards2` and `app.js?v=cards2`. Keep `theme-orb.js?v=moon5`.

API (`server/canvas.js`, `server/index.js`)

- `POST /v1/me/canvas/assignments/:id/complete`
- `markAssignmentComplete` writes a Canvas planner override (`marked_complete`).
- Assignments now carry `plannerOverrideId` and `plannableType`.
- Relative Canvas `html_url` values are turned into `https://eastsideprep.instructure.com/...`.

iOS (`Panels.swift`, `DashboardStore.swift`, `Models.swift`)

- The bubble is a `Button`. `markDone` sets `done` inside `withAnimation(.spring)`.
- Then it POSTs the same complete route.

Earlier, related: HW/QA/MA filter chips update in place (`paintAssignmentFilters`). Do not go back to `routeAndRender` on a chip or checkbox click. That remount grows the glass panels.

## Do not

- Do not remount the dashboard to complete a row.
- Do not start Express from a laptop. Port 3006 lives on this Mac.
- Do not run `vercel git connect`.
