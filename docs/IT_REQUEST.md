# What we need from Eastside Prep IT

One email, four asks. Everything below is already coded on the EPSynapse side and turns on the moment the value lands in `server/.env` (or Secret Manager once the API runs on the school GCP project). Details for each item live in `docs/MICROSOFT_APP.md`, `docs/EPS_INTEGRATIONS.md`, and `docs/GCP.md`.

## Draft email

Subject: EPSynapse: four things to make it a proper school app

Hi Mr. Briggs,

Thanks for unblocking the accounts and for the write-up. You were right about the cause. EPSynapse was using the device-code grant against the Office first-party client id. That code is gone. The API now only knows one Microsoft sign-in, authorization code + PKCE against our own app registration, and until that registration exists Microsoft sign-in is simply off. We also cleared every stored Microsoft token for every account that had signed in, so nothing polls anymore.

We are also splitting the app in two. EPS students will sign in with their @eastsideprep.org Microsoft account and get four11, OneDrive, OneNote, Outlook, and Teams in that one step, no student id or school picker. Students from other schools sign in with Google, upload a schedule PDF, and use a manual Canvas token. The EPS accounts that signed in during the hackathon are paused until this is set up.

To finish the EPS side we need four things from you.

1. Microsoft Entra app registration in the EPS tenant

Please create it in the school tenant (b2681e8b-dd20-46cf-b163-371a2d7c6014) so it is owned by the school and outlives us. Name: EPSynapse. Supported account types: this organization only is fine. Platform: public client / mobile and desktop (PKCE, no secret). Redirect URIs:

- https://api.epsynapse.com/v1/ms/callback
- http://localhost:3006/v1/ms/callback

Delegated Microsoft Graph permissions, signed-in user only: User.Read, Files.ReadWrite, Notes.ReadWrite, Mail.ReadWrite, Mail.Send, Chat.ReadWrite, offline_access, openid, profile, email. If you can grant admin consent for the tenant, students never see a consent prompt. Please add the four of us as owners and send us the Application (client) id. Nothing else is needed on our side.

2. four11 API key

epschedule reads `four11.eastsideprep.org/epschedule/people` and `/epsnet/courses/{id}` with an API key IT issued. We would like the same kind of key so a student who signs in with Microsoft gets their exact schedule with no PDF upload. We match on the school email, read only that student's own courses, and refresh once a night at 00:15 the same way epschedule does. Nothing is cached beyond the current term.

3. Canvas Developer Key

Today every student pastes an access token from Canvas settings and repeats it when it expires. A Developer Key (Type: API key) on eastsideprep.instructure.com lets them click Connect and authorize once. Redirect URI: https://api.epsynapse.com/v1/canvas/callback. No enforced scopes needed (the app reads courses, assignments, grades, and marks assignments complete for the signed-in student only). Please send the client id and secret. If a developer key is not something you want to hand out, lifting the access-token expiry for the EPSynapse app would also work, but the developer key is the cleaner path.

4. A school-owned Google Cloud project

We want EPSynapse to run on the same stack as epschedule (App Engine, Firestore, Cloud Storage, Secret Manager) so it lives in a school project rather than a student's personal account, and so it keeps running after we graduate. Could you create a project under the school Google org (for example `epsynapse`), enable App Engine, Firestore in native mode, Cloud Storage, and Secret Manager, and give the four of us App Engine Deployer, Firestore User, Storage Object Admin, and Secret Manager Secret Accessor? Usage should sit inside the free tier, same as epschedule. We will point api.epsynapse.com at it once it is up.

Happy to walk through any of this in person, and thanks again for catching the sign-in problem before it did real damage.

Yan, Prasham, Everette, and Angela

## After IT answers

| Item | Where it goes |
|------|---------------|
| Entra client id | `MICROSOFT_CLIENT_ID` in `server/.env` (see `docs/MICROSOFT_APP.md`, Part 1, "Wire it into the API") |
| four11 key | `FOUR11_API_KEY` |
| Canvas developer key | `CANVAS_OAUTH_CLIENT_ID`, `CANVAS_OAUTH_CLIENT_SECRET` |
| GCP project | `gcloud config set project`, then follow `docs/GCP.md` |

Once the Entra id is in, flip the EPS door from "coming soon" to live in `app.js` and the iOS sign-in view, and run `node --env-file=.env tools/set-door.mjs <email> eps --resume` from `server/` for each paused EPS account.
