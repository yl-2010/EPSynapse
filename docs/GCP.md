# Running the API on Google Cloud (App Engine)

The Express API in `server/` can run on the same Google Cloud stack that Eastside Prep's [epschedule](https://github.com/guberti/epschedule) uses: App Engine standard, Firestore, Cloud Storage, Secret Manager. Nothing in the code changes between the Mac and the cloud. Three environment variables pick the backends.

Until a school project exists the Mac Studio keeps serving `api.epsynapse.com` exactly as before. See [`STARTUP.md`](STARTUP.md).

## Why this stack

The Mac Studio belongs to a student. When that student graduates the API, the data, and the tunnel go with them. epschedule solved the same problem years ago by living in a school-owned GCP project (`epschedule-v2`), and it is still running because ownership never depended on one person.

We copy that shape on purpose. Same platform, same services, same deploy command. IT already knows how to hand out roles on it, and anyone who has looked at epschedule can read our `app.yaml` without a briefing.

The free tiers cover a school this size. App Engine standard gives 28 instance hours a day, Firestore gives 50k reads and 20k writes a day, Cloud Storage gives 5 GB. Secret Manager charges six cents per secret version per month.

## What IT creates

One time, in the school's Google Cloud organization.

1. A project, for example `epsynapse-eps`. Note the project id, it goes in every command below.
2. Enable App Engine in the project and pick a region. `us-west1` is closest to Kirkland. The region cannot change later.
3. Enable the Firestore API and create the database in Native mode, same region. Keep the default database id `(default)`.
4. Enable the Cloud Storage API. App Engine already created the default bucket `<project-id>.appspot.com`. That is the bucket the API uses unless `GCS_BUCKET` is set. If IT prefers a named bucket, create it in the same region and set `GCS_BUCKET` in `server/app.yaml`.
5. Enable the Secret Manager API and create one secret per name in the `SECRET_NAMES` list in `server/app.yaml`. Missing secrets only log a warning at boot, so it is fine to add them over time.
6. Grant the App Engine default service account (`<project-id>@appspot.gserviceaccount.com`) these roles. App Engine created it in step 2.
   - `roles/datastore.user` (Firestore read and write)
   - `roles/storage.objectAdmin` on the bucket
   - `roles/secretmanager.secretAccessor`
7. Grant the students who deploy these roles on the project.
   - `roles/appengine.deployer`
   - `roles/appengine.serviceAdmin`
   - `roles/cloudbuild.builds.editor`
   - `roles/storage.admin` (deploys stage source in a bucket)
   - `roles/iam.serviceAccountUser` on the App Engine default service account
   - `roles/secretmanager.admin` if students will rotate secrets themselves. Otherwise IT owns the secrets and students only need to know the names.

Nothing here needs the students to hold a billing role.

## Environment variables

App Engine sets `PORT` (8080) and `GOOGLE_CLOUD_PROJECT` on its own. `server/index.js` already reads `process.env.PORT`.

The switches, all in `server/app.yaml` under `env_variables`:

| Variable | Cloud value | Mac value | What it does |
|----------|-------------|-----------|--------------|
| `STORAGE_BACKEND` | `firestore` | unset (`files`) | Where JSON documents live. `store.js` |
| `BLOB_BACKEND` | `gcs` | unset (`files`) | Where uploaded files live. `blobs.js` |
| `GCS_BUCKET` | empty or a bucket name | unset | Empty means `<project>.appspot.com` |
| `GCS_PREFIX` | unset | unset | Optional object name prefix inside the bucket |
| `FIRESTORE_PREFIX` | empty | unset | Prefix on top-level collection names, for sharing a database |
| `FIRESTORE_DATABASE_ID` | unset | unset | Only if IT created a non-default database |
| `SECRETS_FROM_MANAGER` | `1` | unset | Read `SECRET_NAMES` from Secret Manager at boot. `secrets.js` |
| `SECRET_NAMES` | comma list | unset | Which secrets to load into `process.env` |
| `PUBLIC_API_BASE` | `https://api.epsynapse.com` | unset | Used in MCP manifests |
| `ALLOWED_ORIGINS` | `https://epsynapse.com,...` | from `.env` | CORS allowlist |
| `MICROSOFT_REDIRECT_URI` | `https://api.epsynapse.com/v1/ms/callback` | from `.env` | Must match the Azure app registration |
| `EPSYNAPSE_DATA_DIR` | unset | unset | Files-mode root override, only for tests and the migration tool |

Everything in `SECRET_NAMES` is read from Secret Manager only when the variable is not already set, so a value in `env_variables` wins over the secret. Do not put secrets in `app.yaml`. On the Mac the same names come from `server/.env` through `--env-file`, and `secrets.js` does nothing because `GOOGLE_CLOUD_PROJECT` is not set.

How the layout maps between the two backends is in the comment table at the top of `server/store.js` and `server/blobs.js`. In short, `data/<collection>/<id>.json` becomes Firestore document `<collection>/<id>`, one level deeper for per-student folders, and any file that is not JSON becomes a Cloud Storage object with its relative path as the object name.

## Deploy

From the repo root, with the [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and signed in as a student who has the deploy roles.

```bash
gcloud config set project <project-id>
gcloud app deploy server/app.yaml
gcloud app browse
```

The first deploy takes a few minutes because Cloud Build runs `npm install`. `server/.gcloudignore` keeps `node_modules/`, `data/`, `.env`, and logs off the upload. `gcloud app browse` opens `https://<project-id>.uw.r.appspot.com`, and `/health` there should return `{"ok":true}`.

Logs:

```bash
gcloud app logs tail -s default
```

Every deploy creates a new version and shifts traffic to it. `gcloud app versions list` shows them. Old versions cost nothing while they have no traffic, but delete them now and then so the list stays readable.

## Custom domain for api.epsynapse.com

Two halves. App Engine needs to know it serves the hostname, and Cloudflare DNS needs to send traffic there.

App Engine side:

```bash
gcloud app domain-mappings create api.epsynapse.com
```

The first time, Google asks you to verify ownership of `epsynapse.com` in Search Console. It gives you a TXT record. Add it in the Cloudflare DNS panel, wait a minute, retry the command. The output then lists the records App Engine wants, normally one CNAME to `ghs.googlehosted.com`. Google provisions a managed certificate for the hostname automatically once DNS resolves. That can take up to an hour.

Cloudflare side, in the `epsynapse.com` zone:

- Delete or rename the existing `api` CNAME that points at the Cloudflare Tunnel (`<tunnel-id>.cfargotunnel.com`).
- Add `CNAME api -> ghs.googlehosted.com`.

Proxy status. Start with the cloud turned off (DNS only, grey cloud). Google needs to see the hostname resolve to its own edge to issue the certificate, and a proxied record hides that. After `gcloud app domain-mappings describe api.epsynapse.com` shows the certificate as active you can switch the record to proxied (orange cloud) if you want Cloudflare in front for caching or WAF rules. With proxy on, set SSL/TLS mode to Full (strict) so Cloudflare talks TLS to Google, and know that App Engine will see Cloudflare's IPs as the client. `index.js` already reads `x-forwarded-proto` for the Secure cookie flag, and Cloudflare sets that header. If you leave the proxy on and something looks wrong, flip it back to DNS only first. That removes Cloudflare from the request path and usually points at the real problem.

Both halves are reversible. Pointing the `api` CNAME back at the tunnel target returns traffic to the Mac within the DNS TTL.

## The Mac until cutover

Nothing changes. `STORAGE_BACKEND` and `BLOB_BACKEND` are unset on the Mac, so `store.js` and `blobs.js` read and write the exact same paths under `server/data/` they always have. No data migration is needed to keep running, `npm install` in `server/` pulls the Google client libraries but they are only imported when a cloud backend is selected, and `server/.env` keeps working through `--env-file`.

The two deployments can run at the same time. The site keeps talking to whichever one the `api` DNS record points at. Session cookies keep working after a cutover because `sessions.json` is part of the migration. Anyone who signed in between the last migration run and the DNS switch signs in again. That is the only visible effect.

## Migrating the data

Run once before switching DNS, and again right after to pick up anything written in between. It reads `server/data/` with plain filesystem calls and writes through the same `store.js` and `blobs.js` code the server uses, so the cloud layout is by construction what the server expects.

```bash
cd server
gcloud auth application-default login
export STORAGE_BACKEND=firestore BLOB_BACKEND=gcs GOOGLE_CLOUD_PROJECT=<project-id>
node tools/migrate-to-gcp.mjs --dry-run
node tools/migrate-to-gcp.mjs
```

Dry run prints every document and object it would write and touches nothing. Rerunning is safe because every write overwrites the same id. `--only=students,notes` limits the copy to top-level folders. The tool also copies the repo-root `research-metrics.json` into Firestore document `meta/research-metrics`, because App Engine only uploads `server/` and the metrics page reads that file.

Check the result in the Cloud Console under Firestore (collections `students`, `notes`, `chats`, and so on) and in the bucket. Then deploy, hit `/health`, sign in on the deployed URL, and only then move DNS.
