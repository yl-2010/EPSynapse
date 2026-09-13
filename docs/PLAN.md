# EPSynapse: plan to a finished product

Last updated Sep 13, 2026. This is the order of work from here to "any EPS student or any other student can sign in and everything works", with what depends on what. Keep it current: when a step lands, mark it and move on.

## Where we are

Done and live:

- Two doors. `door: "eps"` and `door: "other"` on every student record. Logged-out screen shows both; the EPS button says coming soon. Existing EPS Google accounts are paused (Yan, Angela, Prasham, Everette, Amy, Jeffery). Web and iOS both handle the paused state.
- Microsoft device-code flow removed for good. Only authorization code + PKCE against our own Entra registration exists, and it is off until `MICROSOFT_CLIENT_ID` is set. All old tokens purged.
- Other door end to end: Google sign-in, schedule PDF parsed by the student's own model with real meeting times, per-school Canvas URL plus manual token, model keys, notes, todos, class files, chat.
- School picker, student id, roster matching, MCP server, hackathon demo code (Cursor SDK agent, Studio flags), BERT sidecar (kept in the repo, off): all removed or off.
- Server code for the EPS door is written and mounted, returning 503 until IT keys arrive: Canvas OAuth via Developer Key (`server/canvas-oauth.js`), four11 schedule sync by school email with a nightly refresh (`server/four11.js`, `cron.yaml`).
- Storage goes through `server/store.js` (files or Firestore), `server/blobs.js` (files or Cloud Storage), `server/secrets.js` (Secret Manager). Secrets are AES-GCM sealed at rest with `DATA_ENCRYPTION_KEY`. Sessions are one doc each. `server/app.yaml` and `server/tools/migrate-to-gcp.mjs` are ready.
- Delete account (`POST /v1/me/delete`) removes everything; the privacy page describes what is stored.
- Repo is github.com/yl-2010/EPSynapse. Local folder, LaunchAgents, logs, package names, and the Vercel project are `epsynapse`.
- Security review (Sep 13) worked through. What was fixed, what waits on IT, and what we chose not to fix is in the "Security review" section below.

## What we are waiting on

Everything below is blocked on the four items in [`IT_REQUEST.md`](IT_REQUEST.md). Nothing else in this list can be finished without them.

| Ask | Unblocks |
|-----|----------|
| A. Entra app registration (client id) | EPS sign-in, Microsoft apps, account linking, unpausing |
| B. four11 API key | EPS schedule with no upload, nightly sync |
| C. Canvas Developer Key | One-click Canvas for EPS, no 90-day tokens |
| D. School-owned GCP project | Hosting off Yan's Mac, survives graduation |

A is the critical path. B, C, D can arrive in any order and each turns on independently.

## Order of work

Steps are numbered in the order to do them. "Needs" lists hard dependencies.

### 1. Send the IT email

Needs: nothing. Owner: Yan. Use the draft in `IT_REQUEST.md`.

### 2. EPS sign-in with Microsoft

Needs: A.

- Put the client id in `server/.env` as `MICROSOFT_CLIENT_ID`. `MICROSOFT_TENANT` already defaults to the EPS tenant.
- Add `POST /v1/auth/microsoft/start` and handle the identity half of `/v1/ms/callback`: verify the id token (issuer, audience, tenant, `@eastsideprep.org` UPN), create or load a student keyed `ms__<oid>`, set `door: "eps"`, `paused: false`, `schoolEmail`. The same consent already carries the Graph scopes for OneDrive, OneNote, Outlook, and Teams, so `mergeGraph` runs in the same callback and all four services are connected with zero extra clicks.
- Web: replace the coming-soon panel with the real button that calls the start route and follows the redirect. iOS: same, returning through `epsynapse://ms`.
- Remove the four Microsoft settings panes in favour of one card ("Connected as name@eastsideprep.org", disconnect).

### 3. Account linking for the paused accounts

Needs: 2.

The six paused Google accounts hold notes, todos, chats, and files. On first Microsoft sign-in, look for a paused Google record with the same display name or an email the student confirms, and merge: move the owner id, copy Canvas and model keys, delete the Google record. Offer "sign in with Google once to claim your old data" as the fallback. Then `tools/set-door.mjs <email> eps --resume` is no longer needed; the merge unpauses.

### 4. Auto-sync on sign-in and nightly

Needs: 2, B.

- Put the key in `FOUR11_API_KEY`. Set `FOUR11_NIGHTLY=1` on the Mac; on App Engine `cron.yaml` runs `/internal/four11/sync-all` at 00:15.
- Call `syncOneStudent` at the end of the Microsoft callback so the dashboard is full on first load.
- Roster refresh happens on the nightly run, same cadence as epschedule.

### 5. Canvas one click for EPS

Needs: 2, C.

Put the id and secret in `CANVAS_OAUTH_CLIENT_ID` / `CANVAS_OAUTH_CLIENT_SECRET`. The Canvas pane for `door === "eps"` shows a single Connect button that calls `/v1/me/canvas/oauth/start`. Manual token stays for the other door. Consider running Canvas OAuth immediately after Microsoft sign-in so the whole EPS onboarding is two consent screens and nothing else.

### 6. Move the API to the school GCP project

Needs: D. Independent of 2 through 5, but do it before unpausing so nobody's data moves twice.

1. `gcloud auth login`, `gcloud config set project <id>`.
2. Create secrets in Secret Manager for every name in `app.yaml` `SECRET_NAMES`.
3. `gcloud app deploy server/app.yaml server/cron.yaml`.
4. Freeze the Mac (stop `com.epsynapse.server`), run `node tools/migrate-to-gcp.mjs` with the cloud env, verify counts.
5. Map `api.epsynapse.com` to App Engine (custom domain in App Engine, CNAME in Cloudflare DNS), then stop `com.epsynapse.cloudflared`.
6. Update `MICROSOFT_REDIRECT_URI`, `CANVAS_OAUTH_REDIRECT_URI` if the host changes (it should not; keep `api.epsynapse.com`).
7. Leave the Mac LaunchAgents disabled but in the repo for one term, then delete.

### 7. Unpause and announce

Needs: 2, 3, 4, 5 tested with at least Yan's account. Flip the coming-soon panel to live in `app.js` and `HomeView.swift`, deploy web, TestFlight build for iOS.

### 8. iOS distribution

Needs: 2 (the Microsoft redirect scheme must be registered on the Entra app first). TestFlight for the team, then App Store review. The bundle id stays `com.jype.epsynapse`; changing it would orphan the Google iOS OAuth client.

### 9. EPS class view, same as yanylevin

Needs: 4 (four11 schedule with real bell times). EPS door only; the other door keeps the Today panel it has now.

Copy the home class view from the yanylevin repo (`education/app.js`: `classSections`, `classesForDay`, `isMeetingHighlighted`, `classRowHtml`; `education/styles.css`: `.edu-class-row`, `.is-current`, `.edu-day-sep`). Differences from yanylevin:

- One panel, not two. Today's classes and the next school day's classes sit in the same "Classes" box, in period order, with the same thin separator line the todo list uses between days (`.edu-day-sep`). The day label sits on the separator the way the todo list labels its days.
- Rows are period tag plus class name, linking to the class page. The row for the class that is happening now (or starts within the lead window, same `CLASS_HIGHLIGHT_LEAD_MINUTES` rule) is highlighted. On a non-school day the panel shows the next two school days.
- Bells and day overrides come from four11 and `eps-bells-2026.json`, not from the LLM parser. Late starts, all-periods days, and no-school days follow the four11 calendar the same way epschedule does.
- iOS: the same single panel in `HomeView`, plus the current-class Live Activity and Dynamic Island from yanylevin (`ios/YanLevin/YanLevinWidgets/ClassLiveActivity.swift`, `LiveActivityCoordinator.swift`): period label, class name, countdown to the end, tap opens the class. Also replace the hardcoded 8:00 bells in `DashboardStore.currentPeriod()` with the server's bells.

Do not fork the logic. Port the functions and keep the names so fixes in yanylevin can be copied over.

## Security review, Sep 13

A separate agent ran a full read-only audit (canvas `epsynapse-security-audit`). Triage against the code as it stands now:

### Fixed the same day

- Server: Canvas host SSRF closed (manual redirects, same-origin `Link` pagination, private and loopback addresses rejected). Google ID tokens must carry the nonce the browser generated. OAuth callbacks bind the grant to the browser session; the native app finishes with an authenticated `POST /v1/me/ms/finish` or `/v1/me/canvas/oauth/finish`. Paused check lives in `requireStudent` and is case-proof; paused accounts get only `GET /v1/me`, logout, delete. API binds to 127.0.0.1 on the Mac. Rate limits on auth, callbacks, chat, PDF upload, metrics. Sessions expire. CORS denies when the allowlist is empty; cross-site POSTs with a foreign `Origin` get 403. Agent-written HTML is served in a sandboxed origin. Generic 5xx messages. `/health` no longer names internal ports. Graph calls have timeouts. PDF text extraction runs in a child process with a timeout and page cap. Blobs and student JSON are 600. Demo Groq key is capped per student per day. four11 never maps a Gmail local part onto an EPS person.
- Web: nonce on both Google flows, sign-out and delete wipe every `epsynapse.*` key and the chat panel, CSP and the other headers in `vercel.json`, KaTeX with Subresource Integrity, one URL allowlist helper, popup listener checks origin, real 404 page, Cursor demo leftovers gone.
- iOS: session token in Keychain, model key never persisted, class HTML in a WKWebView with JavaScript off and no free navigation, URL scheme check before `openURL`, deep link ignored unless a sign-in is pending, file protection on caches, temp PDF deleted after upload.
- Mac: `server/.env` is 600 and no longer holds the unused Google web client secret or the Cursor key; `server/data` is `go-rwx`; logs moved from `/tmp` to `~/Library/Logs/epsynapse` (700); deploy script sources only `~/.config/epsynapse/vercel.env` after checking its mode and content, and pins the Vercel CLI; tunnel recreate script requires an explicit JYPE-account cert.

### Fix after IT answers

- Exercise the OAuth session binding and the native `/finish` routes with real Microsoft and Canvas keys. The code is in; it has only been import-checked.
- four11 match: once Microsoft sign-in lands, the Microsoft-verified `@eastsideprep.org` email is the only key used to find a student in the roster. Drop the Google email candidates then.
- GCP move: Firestore in production (locked) rules mode, `storage.admin` scoped to the staging bucket only, one Secret Manager secret per `SECRET_NAMES` entry. Bump `@google-cloud/firestore` and `@google-cloud/storage` to current majors right before the first App Engine deploy, where they can be tested.
- Rotate the Google web OAuth client secret in the Google Cloud console. Nothing uses it, but it sat in a world-readable file.

### Not fixing, on purpose

- Prompt injection into the agent (send mail, Teams messages, delete tools, remote images in markdown, agent-written files). Every `/v1/me/*` and `/v1/agent/*` route derives the owner from the session and the audit found no way for one student's agent to reach another student's data. The worst case is a student's own model acting on their own account, which is the trade we accept.
- Session id in `localStorage` as well as the cookie. The header path is what iOS and cross-site fetches use. With the CSP in place the XSS ceiling is what the audit wanted lowered.
- Python BERT dependency pins. BERT is off.
- `prefersEphemeralWebBrowserSession` stays false on iOS so the school Microsoft sign-in can reuse Safari's session.

### Your call, Yan

- Repo visibility. The public repo prints Cloudflare zone and tunnel ids, Vercel ids, the EPS tenant id, `/Users/yanlevin/` paths, and four students' names. None of it grants access. Make the repo private if that bothers you; nothing in the deploy path depends on it being public.
- macOS firewall is off on the Mac Studio. The API now binds to loopback so LAN access is closed anyway. Turning the firewall on is a one-line `socketfilterfw` change but it prompts for every listening app, including the yanylevin, NoteLMs, and SocketHR servers.
- Two extra copies of the Vercel token exist (`~/.config/jype/vercel.env` and the Cursor agent store). The deploy script ignores them now. Delete them when you are sure nothing else reads them.

## Independent cleanup, any time

- The Cloudflare tunnel object is still called `jype-api` and the Cloudflare and Vercel accounts are still named JYPE. Those are account-level names; rename from their dashboards if wanted. Nothing depends on them.
- `data/schools/` on the Mac is dead data from the school picker. Delete after the GCP migration.
- Decide whether `hanshul.dua99`, `holmesd`, `milevin`, `pranavsankar614` are EPS; pause them if so.

## Dependency graph

```
IT email ─┬─ A Entra id ──► 2 MS sign-in ──► 3 linking ──► 7 unpause ──► 8 iOS
          │                     │  │
          ├─ B four11 key ──────┘──► 4 auto sync
          │                        │
          ├─ C Canvas key ─────────┘──► 5 Canvas one click
          │
          └─ D GCP project ──► 6 migrate ──► (before 7)
```
