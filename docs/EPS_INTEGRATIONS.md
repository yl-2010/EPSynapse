# Eastside Prep integrations: Canvas OAuth and four11

Two things need a credential from Eastside Prep IT before the EPS door can go live. Canvas needs a Developer Key so students sign in with a Canvas login instead of pasting a token. Schedules need a four11 API key, the same kind epschedule runs on. This page says what to ask for, where the values go, and what the server does with them.

Code: `server/canvas-oauth.js` and `server/four11.js`.

## What IT needs to hand us

### Canvas Developer Key

In Canvas as an account admin, go to Admin > Developer Keys > + Developer Key > + API Key.

- Key name: `EPSynapse`
- Owner email: a team address
- Redirect URIs: `https://api.epsynapse.com/v1/canvas/callback`
  Add `http://localhost:3006/v1/canvas/callback` on a second line if we want local testing.
- Enforce scopes: off. The key then issues tokens with the same access the student already has in Canvas. If IT prefers scoped keys, ask for the read scopes on courses, assignments, enrollments, planner, users self, and submissions, and set `CANVAS_OAUTH_SCOPES` to that list.
- Test cluster only: off.
- After saving, switch the key state to On.

IT sends back the client ID (the numeric key id) and the client secret. Canvas will show EPSynapse on the consent screen and in each student's Approved Integrations list, where they can revoke it.

### four11 API key

epschedule holds a bearer key for `https://four11.eastsideprep.org`. We are asking for one like it. It only needs to reach two GET endpoints:

- `/epschedule/people`, the roster (id, first and last name, preferred name, email, gradyear, lunch id, photo url)
- `/epsnet/courses/{username}?term_id=1|2|3`, one person's sections for a trimester (period, location, course, teacher, department) plus their `individual` record

Both take `Authorization: Bearer <key>`. Nothing is written back to four11.

## Env vars

Put these in `server/.env` on the Mac Studio. Each block stays off until its first value is set.

```
CANVAS_OAUTH_CLIENT_ID=<developer key id>
CANVAS_OAUTH_CLIENT_SECRET=<developer key secret>
CANVAS_OAUTH_HOST=https://eastsideprep.instructure.com
CANVAS_OAUTH_REDIRECT_URI=https://api.epsynapse.com/v1/canvas/callback
CANVAS_OAUTH_SCOPES=

FOUR11_API_KEY=<four11 bearer key>
FOUR11_BASE=https://four11.eastsideprep.org
```

Host, redirect URI, and base have the defaults shown, so only the id, secret, and key lines are required. Then restart the API and check `/health`.

## Flows

### Canvas sign-in (EPS students only)

1. The app calls `POST /v1/me/canvas/oauth/start` with the session cookie and an optional `returnTo`. Students on the other door get 403 and keep the manual token field. When `CANVAS_OAUTH_CLIENT_ID` is unset the route answers 503.
2. The server makes a random `state`, remembers which student it belongs to, and returns `authorizeUrl`, which is `{host}/login/oauth2/auth?client_id&response_type=code&redirect_uri&state`.
3. The browser opens that URL, the student signs in to Canvas, and Canvas redirects to `https://api.epsynapse.com/v1/canvas/callback?code&state`.
4. The server posts the code to `{host}/login/oauth2/token` with `grant_type=authorization_code`, stores `access_token` as `canvasToken`, keeps the refresh token and expiry, and redirects to `returnTo/?canvas=connected` (or `?canvas=error&reason=...`). iOS gets `epsynapse://canvas?canvas=connected`. Allowed return origins are epsynapse.com, www.epsynapse.com, jype-six.vercel.app, localhost, and 127.0.0.1.
5. Access tokens last one hour. `ensureFreshCanvasToken(student)` refreshes with `grant_type=refresh_token` when the token is within two minutes of expiry. The refresh token does not expire unless revoked.
6. `POST /v1/me/canvas/oauth/disconnect` sends `DELETE {host}/login/oauth2/token` with the bearer, then clears the stored token fields.

The state entry lives 15 minutes. It is kept in memory and, once `students.js` hydrate() keeps the `canvasAuth` field, on the student record too so a restart mid sign-in does not break the return hop.

### four11 schedule sync (EPS students only)

1. The app calls `POST /v1/me/schedule/four11/sync`. 503 when the key is unset, 403 for the other door.
2. The server loads the roster (cached six hours) and looks up the student by email, trying the Microsoft sign-in email first and the Google email second. Not on the roster gives 404.
3. It fetches `term_id` 1, 2, and 3 for that username and builds `{ terms: { fall, winter, spring } }` the way epschedule does: split the period on the first space so `A - US` becomes `A`, keep only A through H and Advisory, fill missing periods with `Free Period`, sort with Advisory last.
4. It also returns `classes` in the same shape the PDF upload writes to `classes.json`, so the class list, todos, and bells keep working. The sync route does not write anything. The caller in `index.js` persists `classes`.
