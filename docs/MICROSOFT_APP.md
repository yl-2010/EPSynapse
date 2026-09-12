# Microsoft app registration for EPSynapse

EPSynapse signs students into Microsoft so it can show their OneNote notebooks, OneDrive files, Outlook mail, and Teams chats. That needs an app registration in Microsoft Entra that belongs to us, plus a one-time approval from Eastside Prep IT. This page covers both.

Part 1 is for the team. Part 2 is written for EPS IT and can be sent as is. Part 3 says what works today.

## Part 1. For the team: register the EPSynapse app in Microsoft Entra

Sign in at https://entra.microsoft.com (or https://portal.azure.com and open Microsoft Entra ID). If your EPS account is not allowed to register apps, sign in with a personal Microsoft account instead. Its default directory works fine as long as you make the registration multitenant in step 3.

1. Go to Identity > Applications > App registrations > New registration.
2. Name: `EPSynapse`.
3. Supported account types: "Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)". This lets EPS accounts sign in even if the registration lives in a different directory.
4. Redirect URI: pick the platform "Public client/native (mobile & desktop)" and enter `https://api.epsynapse.com/v1/ms/callback`. Click Register.
5. Open Authentication. Under the Mobile and desktop applications platform, add a second redirect URI, `http://localhost:3006/v1/ms/callback`, for local testing. Save.
6. Still under Authentication, set "Allow public client flows" to Yes. This keeps the device-code fallback working. Save.
7. Open API permissions > Add a permission > Microsoft Graph > Delegated permissions. Add `User.Read`, `Files.ReadWrite`, `Notes.ReadWrite`, `Mail.ReadWrite`, `Mail.Send`, `Chat.ReadWrite`, `offline_access`, `openid`, `profile`, `email`. Click Add permissions. Do not click "Grant admin consent" here unless you are an admin of the EPS tenant; that button only affects the directory the registration lives in.
8. Open Branding & properties. Set the home page to `https://epsynapse.com`, upload the logo from `logos/mark.png`, and set the publisher domain if the directory has a verified one. Microsoft shows "unverified" on the consent screen for publishers without MPN verification. That is fine for the hackathon.
9. Open Overview and copy the Application (client) ID.

The iOS app returns through the custom scheme `epsynapse://ms`. The API handles that by redirecting from the https callback, so only the https and localhost URIs above need to be registered.

### Web platform instead of public client

The public client platform uses PKCE and has no secret. If you would rather use the "Web" platform, add the same redirect URIs there, then open Certificates & secrets > New client secret, copy the value once, and put it in `server/.env` as `MICROSOFT_CLIENT_SECRET`. The server sends the secret on the token call when that variable is set. Secrets expire (max 24 months), so the public client setup is less to maintain.

### Wire it into the API

Edit `server/.env` on the Mac Studio:

```
MICROSOFT_CLIENT_ID=<Application (client) ID from step 9>
MICROSOFT_CLIENT_SECRET=            # only for the Web platform
MICROSOFT_TENANT=b2681e8b-dd20-46cf-b163-371a2d7c6014   # or "organizations"
MICROSOFT_REDIRECT_URI=https://api.epsynapse.com/v1/ms/callback
MICROSOFT_SCOPES=User.Read Files.ReadWrite Notes.ReadWrite Mail.ReadWrite Mail.Send Chat.ReadWrite offline_access openid profile email
SCHOOL_IT_EMAIL=<address the "Send request to school IT" button emails>
```

Every value except `MICROSOFT_CLIENT_ID` and `SCHOOL_IT_EMAIL` has the default shown, so you can leave those lines out. Then restart and check health:

```bash
launchctl kickstart -k "gui/$(id -u)/com.jype.server"
curl -sS -f http://127.0.0.1:3006/health
```

### How to test

Sign in to https://epsynapse.com as a student who is not the demo account. Open Settings > OneNote and tap Connect. One of three things happens.

a. The EPS tenant allows users to consent. Microsoft shows a consent screen titled "Permissions requested" that lists the ten permissions above with EPSynapse as the app name. Accept, and you land back on the site. The OneNote pane says Connected only after Graph returns a notebook list.

b. The tenant requires admin consent. Microsoft shows "Need admin approval" (older text: "Approval required"). If IT has turned on the admin consent workflow, the page has a "Request approval" box with a justification field. Fill it in. Otherwise the page just says to contact an administrator. Back on the site, the OneNote pane stays disconnected and shows the "Send request to school IT" button, which emails `SCHOOL_IT_EMAIL` with the admin consent link from Part 2.

c. IT has approved. Tap Connect again. Microsoft signs the student in with no consent screen, the API stores the token, and the pane says Connected once notebooks come back from Graph. OneDrive, Outlook, and Teams use the same token, and each reports its own status from its own Graph call.

## Part 2. For Eastside Prep IT: approve EPSynapse

### What EPSynapse is

EPSynapse (https://epsynapse.com) is a student home page for Eastside Prep. It pulls Canvas assignments, OneNote class notebooks, OneDrive files, Outlook mail, and Teams chats into one place so a student can see the whole day without opening five tabs. Four EPS students built it: Jeffery Xu, Yan Levin, Prasham Dhruva, and Everette Deng.

Students sign in with their own EPS Microsoft account. Microsoft asks for consent on first sign-in, and in the EPS tenant that consent needs an administrator. We are asking for that approval.

### What we ask

Grant tenant-wide admin consent for the delegated Microsoft Graph permissions below on the EPSynapse app registration.

| Permission | Why |
|------------|-----|
| `User.Read` | Read the signed-in student's name and email to label the account. |
| `Files.ReadWrite` | List and open the student's own OneDrive files; save exports back. |
| `Notes.ReadWrite` | Read and create pages in the student's own class notebooks. |
| `Mail.ReadWrite` | Show the student's inbox and mark messages read. |
| `Mail.Send` | Send mail as the student when they hit Send inside EPSynapse. |
| `Chat.ReadWrite` | Show the student's Teams chats and send replies they type. |
| `offline_access` | Get a refresh token so the student does not sign in every hour. |
| `openid`, `profile`, `email` | Standard sign-in claims. No extra data. |

### What the app cannot do

- Delegated permissions only. EPSynapse acts as the signed-in student and can see only what that student can already see.
- No application permissions. No background access to anyone's data.
- No directory-wide access. No user lists, no groups, no other students' notebooks or mail.
- Tokens live on the EPSynapse API server. A student can disconnect in Settings, which deletes the token, and can revoke the app under https://myapps.microsoft.com at any time.
- No data is sold or shared with third parties.

### How to approve

Option A. Open this link and sign in as a Global Administrator or Cloud Application Administrator. Review the permissions and click Accept.

```
https://login.microsoftonline.com/b2681e8b-dd20-46cf-b163-371a2d7c6014/v2.0/adminconsent?client_id=<MICROSOFT_CLIENT_ID>&scope=https://graph.microsoft.com/.default&redirect_uri=https://epsynapse.com/?ms=admin-consent
```

The "Send request to school IT" button in the app emails this link with the real client id filled in.

Option B. In the Entra admin center go to Identity > Applications > Enterprise applications > EPSynapse > Permissions and click "Grant admin consent for Eastside Preparatory School". EPSynapse appears in Enterprise applications after the first student attempts to sign in.

Option C. Turn on the admin consent workflow at Identity > Applications > Enterprise applications > Consent and permissions > Admin consent settings. Set "Users can request admin consent to apps they are unable to consent to" to Yes and pick reviewers. Student requests then land in Identity > Applications > Enterprise applications > Admin consent requests.

### How to revoke later

Remove access for everyone: Identity > Applications > Enterprise applications > EPSynapse > Properties > Delete. Remove access for one student: Identity > Users > pick the user > Applications > EPSynapse > Remove.

### Contact

Team JYPE, `<team email placeholder>`. Any of the four students can answer questions.

## Part 3. Current state

What is set up now:

- Sign-in uses a device-code flow against the Microsoft Office client id `d3590ed6-52b3-4102-aeff-aad2292ab01c` in the EPS tenant. That client is pre-consented, so Microsoft never shows a consent screen. Its token has `Notes.Create` but no OneNote read scope, and for at least one student `GET /me/drive/root` returns 401.
- Each Microsoft service pane (OneNote, OneDrive, Outlook, Teams) now reports its own status from a real Graph call. The app no longer says Connected when Graph says no.
- A "Send request to school IT" button emails the admin consent link to `SCHOOL_IT_EMAIL`.
- The server reads `MICROSOFT_CLIENT_ID` and the other variables from the section above and switches to authorization code + PKCE when a client id is set.

What is blocked on the app registration:

- The consent screen, the admin approval path, and the full scope list in Part 1. None of it can be tested until `MICROSOFT_CLIENT_ID` points at our own registration.
- OneNote read access and a reliable OneDrive root for every student.

The judges' demo account is separate. It uses a Mac-local OneNote session on the studio machine and does not go through Microsoft sign-in, so nothing here changes the demo.
