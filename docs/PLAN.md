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
- Repo is github.com/yl-2010/EPSynapse. LaunchAgents, logs, package names, and the Vercel project are `epsynapse`.

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

## Independent cleanup, any time

- Rename the local folder `~/github/JYPE` to `~/github/EPSynapse` (LaunchAgent plists already point at the new path; re-run `deploy/launchagents/install.sh` after moving).
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
