# Dashboard handoff (stopped 12 Sep 2026, ~10:40)

Stopped mid-build so a Mac Studio agent can take over. This machine is Adi's MacBook Neo, not the Studio. No dashboard code landed in JYPE. `main` is still `9811bb3` (personal agent). Live site is still the placeholder plus `/agent.html`.

Plan (do not edit): Cursor plan `student_dashboard_setup_71cc583e` / `.cursor/plans/student_dashboard_setup_71cc583e.plan.md`.

## Done

- Pulled `main`. Clean. Latest commit: student Groq/Gemini agent.
- Cloned `yl-2010/yanylevin` as a **sibling**, not inside JYPE:
  - On this laptop: `/Users/yanlevin/github/yanylevin`
  - Studio will not have this until you clone it there the same way. SSH to GitHub timed out here; `gh repo clone yl-2010/yanylevin /Users/yanlevin/github/yanylevin` worked.
- Read the inspiration files. Do not copy `education/yanylevin@gmail.com/` or any personal education data into JYPE.

## Not done

Nothing from the plan after the clone. No `liquid-glass.js` in JYPE. `index.html` is still the roster placeholder. No `server/students.js`, `server/canvas.js`, `server/onedrive.js`. No `server/data/`. No deploy, no API restart.

## Product decisions already made

- Student home is a yanylevin education dashboard clone: liquid glass orbs, theme orb, bottom-right chat pill. Palette only: EPS navy + gold (dark navy / gold accent; light muted navy / same gold). Sample from eastsideprep.org, not a guess.
- School + student ID in a settings sheet. Honor-system identity for later admin aggregates. No Google login.
- Canvas: student pastes an access token. Default host `https://eastsideprep.instructure.com`. Read only.
- OneDrive: school account, no IT ticket. Same Graph trick yanylevin uses (Outlook Web first-party client `9199bf20-a13f-4107-85dc-02114787ef48`, EPS tenant `b2681e8b-dd20-46cf-b163-371a2d7c6014`). Device-code first; paste-token if Microsoft blocks it. Writes to `/EPSynapse/` on their drive. Not a Daytona sandbox. Not personal OneDrive. Not an Entra app.
- Chat stays the pill. Fold `/agent.html` into it. Model key stays in the browser (`localStorage` / `Authorization`). Attach a live Canvas + OneDrive snapshot on each turn. Do not persist the model key.
- `epsynapse.com` → `api.epsynapse.com` is cross-origin. Cookie needs `SameSite=None; Secure` plus an explicit CORS origin, or send a session id header as a fallback.

## Files to read in the yanylevin sibling (do not edit that repo)

- `liquid-glass.js`, `theme-orb.js`
- `education/index.html`, `education/styles.css`, `education/app.js`, `education/chatbot.js`
- Graph connect: `server/school-onenote.js`, `server/school-mail.js`
- Home layout in `education/app.js` `renderHome()` (~line 1900): TODO + Completed left, day/classes + dates right

`education/styles.css` is ~2200 lines. Copy the chrome and swap the `:root` tokens. Do not re-skin from scratch.

## Next

1. Clone yanylevin on the Studio if missing.
2. Port glass + EPS colors onto `index.html`. Redirect `agent.html` here.
3. `server/students.js` + gitignored `server/data/`.
4. Canvas live courses/assignments.
5. OneDrive device-code / Graph.
6. Chat pill + snapshot.
7. Push `main`, `npm run deploy:web`, `launchctl kickstart` the Studio API.

Leave `ideas.md` and README "was here" lines alone.
