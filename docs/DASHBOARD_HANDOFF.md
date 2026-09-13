# Student dashboard

Landed on the Studio.

- `index.html` is the student home. `agent.html` redirects here.
- Glass chrome: `liquid-glass.js`, `theme-orb.js`, `styles.css` (EPS navy + gold from eastsideprep.org).
- Settings sheet: school, student ID, Canvas token, OneDrive connect, model key on the Google account.
- Mac modules: `server/students.js`, `server/canvas.js`, `server/onedrive.js`. Profiles in gitignored `server/data/`.
- Chat pill posts `/v1/agent/chat`. Server attaches a live Canvas + OneDrive snapshot and uses the account model key.

Device code was removed Sep 13. School OneDrive now uses authorization code + PKCE against EPSynapse's own Entra app, and Microsoft sign-in stays off until `MICROSOFT_CLIENT_ID` is set.
