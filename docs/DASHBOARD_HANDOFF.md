# Student dashboard

Landed on the Studio.

- `index.html` is the student home. `agent.html` redirects here.
- Glass chrome: `liquid-glass.js`, `theme-orb.js`, `styles.css` (EPS navy + gold from eastsideprep.org).
- Settings sheet: school, student ID, Canvas token, OneDrive connect, model key on the Google account.
- Mac modules: `server/students.js`, `server/canvas.js`, `server/onedrive.js`. Profiles in gitignored `server/data/`.
- Chat pill posts `/v1/agent/chat`. Server attaches a live Canvas + OneDrive snapshot and uses the account model key.

Device-code for school OneDrive works with the Outlook Web first-party client. Paste-token is still there if Microsoft blocks a student.
