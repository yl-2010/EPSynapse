# Dashboard handoff (stopped 12 Sep 2026, ~10:40)

Stopped mid-build so a Mac Studio agent can take over. This machine is Adi's MacBook Neo, not the Studio. No dashboard code landed in JYPE. `main` is still `9811bb3` (personal agent). Live site is still the placeholder plus `/agent.html`.

Plan (do not edit): Cursor plan `student_dashboard_setup_71cc583e` / `.cursor/plans/student_dashboard_setup_71cc583e.plan.md`.

## Done

- Pulled `main`. Clean. Latest commit: student Groq/Gemini agent.
- Do not copy personal education data into JYPE.

## Not done

No `liquid-glass.js` in JYPE. `index.html` is still the roster placeholder. No `server/students.js`, `server/canvas.js`, `server/onedrive.js`. No `server/data/`. No deploy, no API restart.

## Product decisions already made

- Student home: liquid glass orbs, theme orb, bottom-right chat pill. Palette only: EPS navy + gold (dark navy / gold accent; light muted navy / same gold). Sample from eastsideprep.org, not a guess.
- School + student ID in a settings sheet. Honor-system identity for later admin aggregates. No Google login.
- Canvas: student pastes an access token. Default host `https://eastsideprep.instructure.com`. Read only.
- OneDrive: school account, no IT ticket. Outlook Web first-party client `9199bf20-a13f-4107-85dc-02114787ef48`, EPS tenant `b2681e8b-dd20-46cf-b163-371a2d7c6014`. Device-code first; paste-token if Microsoft blocks it. Writes to `/EPSynapse/` on their drive. Not a Daytona sandbox. Not personal OneDrive. Not an Entra app.
- Chat stays the pill. Fold `/agent.html` into it. Model key stays in the browser (`localStorage` / `Authorization`). Attach a live Canvas + OneDrive snapshot on each turn. Do not persist the model key.
- `epsynapse.com` → `api.epsynapse.com` is cross-origin. Cookie needs `SameSite=None; Secure` plus an explicit CORS origin, or send a session id header as a fallback.

## Home layout to build

TODO + Completed on the left. Day / classes + dates on the right. Copy the chrome and swap the `:root` tokens. Do not re-skin from scratch.

## Next

1. Port glass + EPS colors onto `index.html`. Redirect `agent.html` here.
2. `server/students.js` + gitignored `server/data/`.
3. Canvas live courses/assignments.
4. OneDrive device-code / Graph.
5. Chat pill + snapshot.
6. Push `main`, `npm run deploy:web`, `launchctl kickstart` the Studio API.

Leave `ideas.md` and README "was here" lines alone.
