(() => {
  const LS_SID = "epsynapse.sid";
  const LS_KEY = "epsynapse.agent.key";
  const LS_PROV = "epsynapse.agent.provider";
  const LS_FILES = "epsynapse.ms.files";
  const LS_LINKS = "epsynapse.ms.links";
  const LS_MAIL = "epsynapse.ms.mail";
  const LS_EVENTS = "epsynapse.ms.events";

  const loading = document.getElementById("stage-loading");
  const stage = document.getElementById("stage-full");
  const appEl = document.getElementById("edu-app");
  const sheet = document.getElementById("settings-sheet");
  const form = document.getElementById("settings-form") || sheet.querySelector("form");
  const sideEl = document.getElementById("settings-side");
  const statusEl = document.getElementById("settings-status");
  const odStatus = document.getElementById("onedrive-status");
  const olStatus = document.getElementById("outlook-status");
  const keyStatus = document.getElementById("key-status");
  const providerSel = document.getElementById("provider");

  let apiBase = "";
  let me = null;
  let odPollTimer = 0;
  let olPollTimer = 0;
  let odPollInFlight = false;
  let olPollInFlight = false;
  const TAGS = ["CW", "HW", "QA", "MA"];
  const PERIOD_TONES = {
    A: "rose",
    B: "amber",
    C: "lime",
    D: "teal",
    E: "sky",
    F: "indigo",
    G: "orchid",
    H: "slate",
  };
  const TONE_CYCLE = ["rose", "amber", "lime", "teal", "sky", "indigo", "orchid", "slate"];
  const typeFilter = new Set(TAGS);
  const TODOS_COLLAPSED_LIMIT = 6;
  let todoExpanded = true;
  let lastHome = {
    courses: [],
    assignments: [],
    files: [],
    filesError: "",
    messages: [],
    mailError: "",
    events: [],
    classes: [],
    meetings: [],
    notes: [],
    grades: [],
    classFiles: [],
    classFilesFor: "",
    classFilesError: "",
  };
  let lastOdError = "";
  let lastOlError = "";
  let classFilesInFlight = "";
  let openMail = null;
  let mailBusy = false;
  let googleClientId = "";
  let gisConfigError = "";
  let gisInitialized = false;
  let schoolTimer = 0;
  const DEFAULT_SCHOOL = "Eastside Prep";
  const NEED_GOOGLE = "Sign in with Google first.";
  const OD_WEB = "https://eastsideprep-my.sharepoint.com/";
  const OL_WEB = "https://outlook.office.com/mail/";

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const val = JSON.parse(raw);
      return val == null ? fallback : val;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  function localFiles() {
    return []
      .concat(readJson(LS_LINKS, []), readJson(LS_FILES, []))
      .filter((f) => f && (f.name || f.webUrl));
  }

  function localMail() {
    return readJson(LS_MAIL, []).filter((m) => m && m.id);
  }

  function localEvents() {
    return readJson(LS_EVENTS, []).filter((e) => e && (e.subject || e.start));
  }

  function mergeById(primary, extra) {
    const out = [];
    const seen = new Set();
    for (const row of [].concat(primary || [], extra || [])) {
      const key = String(row?.id || row?.webUrl || row?.name || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    return out;
  }

  function uselessMsError(err) {
    const e = String(err || "").toLowerCase();
    if (!e) return true;
    return (
      e.includes("connect outlook") ||
      e.includes("connect onedrive") ||
      e.includes("sign in with google") ||
      e.includes("cannot get") ||
      e.includes("not connected")
    );
  }

  function parseIcsDate(raw) {
    const s = String(raw || "").trim();
    const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
    if (!m) return "";
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}${m[7] || ""}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }

  function icsField(block, name) {
    for (const line of String(block || "").split(/\n/)) {
      if (line.startsWith(`${name}:`) || line.startsWith(`${name};`)) {
        const i = line.indexOf(":");
        return i >= 0 ? line.slice(i + 1).trim() : "";
      }
    }
    return "";
  }

  function parseIcs(text) {
    const unfolded = String(text || "")
      .replace(/\r\n[ \t]/g, "")
      .replace(/\r\n/g, "\n");
    return unfolded
      .split("BEGIN:VEVENT")
      .slice(1)
      .map((chunk, i) => {
        const block = chunk.split("END:VEVENT")[0] || "";
        const start = parseIcsDate(icsField(block, "DTSTART"));
        return {
          id: icsField(block, "UID") || `ics:${i}:${start}`,
          subject: icsField(block, "SUMMARY") || "Event",
          start,
          end: parseIcsDate(icsField(block, "DTEND")),
          location: icsField(block, "LOCATION"),
          webLink: "",
        };
      })
      .filter((e) => e.start || e.subject);
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sid() {
    return localStorage.getItem(LS_SID) || "";
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    const session = sid();
    if (session) headers["X-EPSynapse-Session"] = session;
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const ctrl = new AbortController();
    const wait = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 8000;
    const timer = setTimeout(() => ctrl.abort(), wait);
    let res;
    try {
      res = await fetch(apiBase + path, {
        credentials: "include",
        ...opts,
        headers,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: text.slice(0, 200) };
    }
    if (body.sessionId) localStorage.setItem(LS_SID, body.sessionId);
    if (!res.ok) {
      const err = new Error(body.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  function setStatus(el, text) {
    if (el) el.textContent = text || "";
  }

  function signedInViaGoogle() {
    return Boolean(me && (me.email || me.googleName));
  }

  function applyAuthGate() {
    const on = signedInViaGoogle();
    const next = on ? "in" : "out";
    const authChanged = document.documentElement.dataset.auth !== next;
    document.documentElement.dataset.auth = next;
    if (authChanged) queueMicrotask(() => window.reinitLiquidGlass?.());
    const out = document.getElementById("stage-out");
    if (on) {
      if (out) out.hidden = true;
      return;
    }
    closeSheet();
    closeChatOverlay();
    if (loading) loading.hidden = true;
    if (stage) stage.hidden = true;
    if (out) out.hidden = false;
  }

  function setOutStatus(text) {
    const el = document.getElementById("stage-out-status");
    if (!el) return;
    if (text) {
      el.hidden = false;
      el.textContent = text;
    } else {
      el.hidden = true;
      el.textContent = "";
    }
  }

  function accountStatusText() {
    if (!signedInViaGoogle()) {
      return gisConfigError || "Sign in with Google. Then add school and student ID so the school can match you.";
    }
    let text = "Signed in with Google.";
    if (me.rosterMatched && me.rosterName) text += ` Matched · ${me.rosterName}`;
    else if (me.rosterName) text += ` ${me.rosterName}`;
    return text;
  }

  function fillFormFromMe() {
    form.school.value = (me && me.school) || DEFAULT_SCHOOL;
    form.studentId.value = (me && me.studentId) || "";
    form.canvasHost.value = (me && me.canvasHost) || "https://eastsideprep.instructure.com";
    const slugEl = document.getElementById("schoolSlug");
    if (slugEl) slugEl.value = (me && me.schoolSlug) || slugEl.value || "";
  }

  function hideSchoolResults() {
    const box = document.getElementById("school-results");
    if (box) {
      box.hidden = true;
      box.innerHTML = "";
    }
  }

  function paintAccount() {
    const profile = document.getElementById("google-profile");
    const outRow = document.getElementById("google-signout-row");
    const redirectBtn = document.getElementById("google-redirect");
    const pic = document.getElementById("google-picture");
    const nameEl = document.getElementById("google-name");
    const emailEl = document.getElementById("google-email");
    const inGoogle = signedInViaGoogle();

    if (inGoogle) {
      if (redirectBtn) {
        redirectBtn.hidden = true;
        redirectBtn.style.display = "none";
      }
      if (profile) profile.hidden = false;
      if (outRow) outRow.hidden = false;
      if (pic) {
        if (me.picture) {
          pic.src = me.picture;
          pic.hidden = false;
        } else {
          pic.removeAttribute("src");
          pic.hidden = true;
        }
      }
      if (nameEl) nameEl.textContent = me.googleName || me.displayName || "Signed in";
      if (emailEl) emailEl.textContent = me.email || "";
    } else {
      if (profile) profile.hidden = true;
      if (outRow) outRow.hidden = true;
      if (redirectBtn) {
        redirectBtn.hidden = false;
        redirectBtn.style.display = "";
      }
    }
    if (statusEl) {
      statusEl.hidden = inGoogle;
      if (!inGoogle) setStatus(statusEl, accountStatusText());
    }
    applyAuthGate();
  }

  function waitForGis(ms) {
    const limit = Number.isFinite(ms) ? ms : 8000;
    return new Promise((resolve) => {
      if (window.google?.accounts?.id) {
        resolve(true);
        return;
      }
      const start = Date.now();
      const timer = setInterval(() => {
        if (window.google?.accounts?.id) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - start > limit) {
          clearInterval(timer);
          resolve(false);
        }
      }, 80);
    });
  }

  function googleRedirectUri() {
    const path = location.pathname || "/";
    if (path === "/") return location.origin;
    return `${location.origin}${path}`;
  }

  async function startGoogleRedirect() {
    if (!googleClientId) {
      try {
        const cfg = await api("/v1/auth/google/config");
        googleClientId = String(cfg.clientId || "").trim();
      } catch (err) {
        const msg =
          err.status === 404
            ? "Google sign-in is not on the API yet. Try again in a minute."
            : err.message || "Could not load Google sign-in.";
        setStatus(statusEl, msg);
        setOutStatus(msg);
        return;
      }
    }
    if (!googleClientId) {
      const msg = gisConfigError || "Google sign-in has no client id from the API yet.";
      setStatus(statusEl, msg);
      setOutStatus(msg);
      return;
    }
    const nonce = crypto.randomUUID();
    const q = [
      ["client_id", googleClientId],
      ["redirect_uri", googleRedirectUri()],
      ["response_type", "id_token"],
      ["scope", "openid email profile"],
      ["nonce", nonce],
      ["prompt", "select_account"],
    ]
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
  }

  function takeHashIdToken() {
    const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
    if (!raw) return "";
    return new URLSearchParams(raw).get("id_token") || "";
  }

  function stripLocationHash() {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  async function consumeGoogleHash() {
    const token = takeHashIdToken();
    if (!token) return false;
    await onGoogleCredential({ credential: token });
    stripLocationHash();
    return true;
  }

  async function onGoogleCredential(resp) {
    const idToken = resp && resp.credential;
    if (!idToken) {
      setStatus(statusEl, "Google did not return a sign-in token.");
      return;
    }
    setStatus(statusEl, "Signing in…");
    try {
      me = await api("/v1/auth/google", {
        method: "POST",
        body: JSON.stringify({ idToken }),
      });
      fillFormFromMe();
      paintAccount();
      paintOnedrive();
      paintOutlook();
      /* Graph device-code is blocked by school admin consent. */
      await migrateLocalKey();
      await loadDashboard();
    } catch (err) {
      const msg =
        err.status === 404
          ? "Google sign-in is not on the API yet."
          : err.message || "Google sign-in failed.";
      setStatus(statusEl, msg);
    }
  }

  async function initGoogle() {
    try {
      const cfg = await api("/v1/auth/google/config");
      googleClientId = String(cfg.clientId || "").trim();
      if (!googleClientId) {
        gisConfigError = "Google sign-in has no client id from the API yet.";
        paintAccount();
        return;
      }
    } catch (err) {
      gisConfigError =
        err.status === 404
          ? "Google sign-in is not on the API yet. Try again in a minute."
          : err.message || "Could not load Google sign-in.";
      paintAccount();
      return;
    }

    const ok = await waitForGis();
    if (!ok) {
      gisInitialized = false;
      gisConfigError = "";
      paintAccount();
      return;
    }

    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: onGoogleCredential,
      ux_mode: "popup",
      use_fedcm_for_prompt: true,
      auto_select: false,
      context: "signin",
    });
    gisInitialized = true;
    gisConfigError = "";
    paintAccount();
  }

  async function searchSchools(q) {
    const box = document.getElementById("school-results");
    if (!box) return;
    try {
      const data = await api(`/v1/schools?q=${encodeURIComponent(String(q || "").trim())}`);
      const schools = data.schools || [];
      if (!schools.length) {
        hideSchoolResults();
        return;
      }
      box.innerHTML = schools
        .map((s) => {
          const name = s.name || s.shortName || s.slug || "";
          const extra = [s.shortName && s.shortName !== name ? s.shortName : "", s.domain || ""]
            .filter(Boolean)
            .join(" · ");
          return `<li role="option" data-slug="${escapeHtml(s.slug || "")}" data-name="${escapeHtml(name)}" data-host="${escapeHtml(s.canvasHost || "")}">
        <span class="edu-school-hit-name">${escapeHtml(name)}</span>
        ${extra ? `<span class="edu-school-hit-meta">${escapeHtml(extra)}</span>` : ""}
      </li>`;
        })
        .join("");
      box.hidden = false;
    } catch {
      hideSchoolResults();
    }
  }

  function pickSchool(li) {
    if (!li) return;
    const name = li.getAttribute("data-name") || DEFAULT_SCHOOL;
    const slug = li.getAttribute("data-slug") || "";
    const host = li.getAttribute("data-host") || "";
    form.school.value = name;
    const slugEl = document.getElementById("schoolSlug");
    if (slugEl) slugEl.value = slug;
    if (host && form.canvasHost) {
      form.canvasHost.value = /^https?:\/\//i.test(host) ? host : `https://${host}`;
    }
    hideSchoolResults();
  }

  async function signOutGoogle() {
    try {
      await api("/v1/me/logout", { method: "POST", body: "{}" });
    } catch {
      /* still clear local session */
    }
    localStorage.removeItem(LS_SID);
    me = null;
    lastHome = { courses: [], assignments: [], files: [], messages: [] };
    if (window.google?.accounts?.id) {
      try {
        window.google.accounts.id.disableAutoSelect();
      } catch {
        /* ignore */
      }
    }
    gisInitialized = Boolean(window.google?.accounts?.id && googleClientId);
    fillFormFromMe();
    paintAccount();
    paintOnedrive();
    paintOutlook();
    lastHome = { courses: [], assignments: [], files: [], messages: [] };
    if (appEl) appEl.innerHTML = "";
  }

  function glassAfterMove() {
    queueMicrotask(() => window.reinitLiquidGlass?.());
  }

  function sideOpen() {
    return sheet.classList.contains("is-side");
  }

  function activePane() {
    return sheet.dataset.pane || "";
  }

  function keysOpen() {
    return sideOpen();
  }

  function accountHasKey() {
    return Boolean(me && me.modelKeySet);
  }

  function applyAgentFromMe() {
    const id = (me && me.modelProvider) || localStorage.getItem(LS_PROV) || "groq";
    if (providerSel && [].some.call(providerSel.options, (o) => o.value === id)) {
      providerSel.value = id;
    }
    localStorage.setItem(LS_PROV, providerSel.value || id);
    document.documentElement.dataset.modelProvider = providerSel.value || id;
    document.documentElement.dataset.modelKeySet = accountHasKey() ? "1" : "";
    refreshKeyStatus();
    window.__epsynapseRefreshChatGuide?.();
  }

  async function saveChatKey() {
    if (!signedInViaGoogle()) {
      setStatus(keyStatus, NEED_GOOGLE);
      return false;
    }
    const key = document.getElementById("modelKey").value.trim();
    if (!key) {
      setStatus(keyStatus, "Paste the Groq key here, then tap Save key.");
      return false;
    }
    setStatus(keyStatus, "Saving…");
    try {
      me = await api("/v1/me/agent", {
        method: "POST",
        body: JSON.stringify({
          provider: providerSel.value || "groq",
          modelKey: key,
        }),
      });
      localStorage.removeItem(LS_KEY);
      localStorage.setItem(LS_PROV, providerSel.value || "groq");
      document.getElementById("modelKey").value = "";
      const entry = document.getElementById("key-entry");
      if (entry) delete entry.dataset.replace;
      applyAgentFromMe();
      setStatus(keyStatus, "Saved on this account. Chat can use it now.");
      closePane();
      return true;
    } catch (err) {
      setStatus(keyStatus, err.message || "Could not save the key.");
      return false;
    }
  }

  async function migrateLocalKey() {
    if (!signedInViaGoogle()) return;
    if (accountHasKey()) {
      localStorage.removeItem(LS_KEY);
      applyAgentFromMe();
      return;
    }
    const leftover = localStorage.getItem(LS_KEY) || "";
    if (!leftover) {
      applyAgentFromMe();
      return;
    }
    try {
      me = await api("/v1/me/agent", {
        method: "POST",
        body: JSON.stringify({
          provider: providerSel.value || localStorage.getItem(LS_PROV) || "groq",
          modelKey: leftover,
        }),
      });
      localStorage.removeItem(LS_KEY);
    } catch {
      /* leftover stays until they save again */
    }
    applyAgentFromMe();
  }

  function paintNavSummaries() {
    const school = document.getElementById("school-summary");
    if (school) {
      school.textContent =
        (form.school && form.school.value.trim()) || (me && me.school) || "Eastside Prep";
    }
    const chat = document.getElementById("chat-summary");
    if (chat) {
      const id = providerSel.value || (me && me.modelProvider) || localStorage.getItem(LS_PROV) || "groq";
      if (accountHasKey()) {
        chat.textContent = id;
      } else {
        chat.textContent = "Add a Groq key";
      }
    }
    const canvas = document.getElementById("canvas-summary");
    if (canvas) canvas.textContent = me && me.canvasConnected ? "Connected" : "URL and token";
    document.querySelectorAll(".set-nav[data-pane]").forEach((btn) => {
      btn.classList.toggle("is-on", btn.getAttribute("data-pane") === activePane());
    });
  }

  function paintKeysSummary() {
    paintNavSummaries();
  }

  function showPane(name) {
    document.querySelectorAll("#settings-side [data-pane]").forEach((el) => {
      el.hidden = el.getAttribute("data-pane") !== name;
    });
  }

  function openPane(name) {
    if (!signedInViaGoogle()) return;
    if (!name) {
      closePane(true);
      return;
    }
    if (activePane() === name) {
      closePane();
      return;
    }
    hideSchoolResults();
    sheet.dataset.pane = name;
    sheet.classList.add("is-side");
    showPane(name);
    if (sideEl) {
      sideEl.setAttribute("aria-hidden", "false");
      sideEl.removeAttribute("inert");
    }
    refreshKeyStatus();
    paintCanvasToken();
    paintOnedrive();
    paintOutlook();
    paintNavSummaries();
    glassAfterMove();
    window.setTimeout(glassAfterMove, 320);
    window.setTimeout(glassAfterMove, 680);
  }

  function closePane(immediate) {
    hideSchoolResults();
    const keyEntry = document.getElementById("key-entry");
    const canvasEntry = document.getElementById("canvas-entry");
    if (keyEntry) delete keyEntry.dataset.replace;
    if (canvasEntry) delete canvasEntry.dataset.replace;
    sheet.classList.remove("is-side");
    delete sheet.dataset.pane;
    document.querySelectorAll("#settings-side [data-pane]").forEach((el) => {
      el.hidden = true;
    });
    if (sideEl) {
      sideEl.setAttribute("aria-hidden", "true");
      sideEl.setAttribute("inert", "");
    }
    refreshKeyStatus();
    paintCanvasToken();
    paintNavSummaries();
    glassAfterMove();
    if (!immediate) window.setTimeout(glassAfterMove, 620);
  }

  function openKeys() {
    openPane("chat");
  }

  function openChatKeySettings() {
    if (!signedInViaGoogle()) return;
    openSheet();
    openPane("chat");
  }

  window.__epsynapseOpenChatKey = openChatKeySettings;

  function closeKeys(immediate) {
    closePane(immediate);
  }

  let sheetAnimTimer = 0;
  let gearTurn = 0;

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function spinSettingsGear() {
    const icon = document.querySelector("#settings-open svg");
    if (!icon) return;
    gearTurn += 90;
    icon.style.transform = `rotate(${gearTurn}deg)`;
  }

  function openSheet() {
    if (!signedInViaGoogle()) return;
    closePane(true);
    window.clearTimeout(sheetAnimTimer);
    sheet.classList.remove("is-leaving");
    sheet.hidden = false;
    if (prefersReducedMotion()) {
      sheet.classList.add("is-open");
    } else {
      sheet.classList.remove("is-open");
      void sheet.offsetWidth;
      sheet.classList.add("is-open");
    }
    document.querySelector("#settings-main .edu-sheet-body")?.scrollTo(0, 0);
    const keyEntry = document.getElementById("key-entry");
    const canvasEntry = document.getElementById("canvas-entry");
    if (keyEntry) delete keyEntry.dataset.replace;
    if (canvasEntry) delete canvasEntry.dataset.replace;
    fillFormFromMe();
    paintAccount();
    refreshKeyStatus();
    paintCanvasToken();
    paintNavSummaries();
    paintOnedrive();
    paintOutlook();
    glassAfterMove();
    window.setTimeout(glassAfterMove, 280);
    window.setTimeout(glassAfterMove, 520);
  }

  function closeSheet() {
    hideSchoolResults();
    closePane(true);
    const finish = () => {
      sheet.hidden = true;
      sheet.classList.remove("is-open", "is-leaving");
    };
    if (sheet.hidden && !sheet.classList.contains("is-open")) return;
    if (prefersReducedMotion() || !sheet.classList.contains("is-open")) {
      finish();
      return;
    }
    sheet.classList.add("is-leaving");
    window.clearTimeout(sheetAnimTimer);
    sheetAnimTimer = window.setTimeout(finish, 260);
  }

  function closeChatOverlay() {
    const minimize = document.querySelector("[data-edu-chat-minimize]");
    if (minimize) {
      minimize.click();
      return;
    }
    const chat = document.getElementById("edu-chat");
    if (!chat) return;
    chat.dataset.state = "closed";
    chat.classList.remove("is-open", "has-panel");
    const panel = chat.querySelector(".yan-chat-panel");
    if (panel) {
      panel.hidden = true;
      panel.setAttribute("aria-hidden", "true");
    }
    const launcher = chat.querySelector(".yan-chat-launcher");
    if (launcher) {
      launcher.setAttribute("aria-expanded", "false");
      launcher.tabIndex = 0;
    }
    const input = chat.querySelector(".yan-chat-input");
    if (input) input.tabIndex = -1;
  }

  function currentRoute() {
    const path = (location.pathname || "/").replace(/\/+$/, "") || "/";
    const classMatch = path.match(/^\/class\/([^/]+)$/);
    if (classMatch) return { page: "class", id: decodeURIComponent(classMatch[1]) };
    const noteMatch = path.match(/^\/note\/([^/]+)$/);
    if (noteMatch) return { page: "note", id: decodeURIComponent(noteMatch[1]) };
    if (path === "/grades") return { page: "grades" };
    return { page: "home" };
  }

  function goTo(path) {
    const next = path || "/";
    if (location.pathname !== next) history.pushState({}, "", next);
    routeAndRender();
    window.scrollTo(0, 0);
  }

  function goHome() {
    closeSheet();
    closeChatOverlay();
    if (!signedInViaGoogle()) return;
    if (loading) loading.hidden = true;
    if (stage) stage.hidden = false;
    goTo("/");
  }

  function panelHtml(title, body, filterId, extraClass, filtersHtml, titleInner) {
    return `<section class="edu-panel${extraClass ? " " + extraClass : ""}" data-filter-id="${escapeHtml(filterId)}">
      <div class="edu-panel-head"><h2 class="edu-panel-title">${titleInner || escapeHtml(title)}</h2>${filtersHtml || ""}</div>
      ${body}
    </section>`;
  }

  function collapseTitle(title, expanded) {
    return `<button type="button" class="edu-todos-toggle" data-todos-expand aria-expanded="${
      expanded ? "true" : "false"
    }" aria-label="${expanded ? "Collapse" : "Expand"} todos">${escapeHtml(title)}</button>`;
  }

  function collapsedSlice(items, expanded, limit) {
    return expanded ? items : items.slice(0, limit);
  }

  function filterBarHtml(kind) {
    return `<div class="edu-filters" role="group" aria-label="${escapeHtml(kind)} filters">${TAGS.map((tag) => {
      const on = typeFilter.has(tag);
      return `<label class="edu-filter circle${on ? " is-on" : ""}" data-liquid-glass="circle" data-filter-id="lg-edu-filter-${escapeHtml(kind)}-${escapeHtml(tag)}" title="${escapeHtml(tag)}" aria-label="${escapeHtml(tag)}"><input type="checkbox" data-filter="${escapeHtml(tag)}" ${on ? "checked" : ""} /><span>${escapeHtml(tag)}</span></label>`;
    }).join("")}</div>`;
  }

  function currentPeriod() {
    const now = new Date();
    if (now.getDay() === 0 || now.getDay() === 6) return null;
    const minutes = now.getHours() * 60 + now.getMinutes();
    const bells = [
      [8 * 60, 8 * 60 + 50, "1", "A"],
      [8 * 60 + 55, 9 * 60 + 45, "2", "B"],
      [9 * 60 + 50, 10 * 60 + 40, "3", "C"],
      [10 * 60 + 45, 11 * 60 + 35, "4", "D"],
      [12 * 60 + 15, 13 * 60 + 5, "5", "E"],
      [13 * 60 + 10, 14 * 60, "6", "F"],
      [14 * 60 + 5, 14 * 60 + 55, "7", "G"],
      [15 * 60, 15 * 60 + 50, "8", "H"],
    ];
    return bells.find(([start, end]) => minutes >= start && minutes < end) || null;
  }

  function matchesTag(item) {
    return typeFilter.has(item.tag || "HW");
  }

  function listOrEmpty(itemsHtml, empty) {
    if (!itemsHtml) return `<p class="edu-empty">${escapeHtml(empty || "Nothing here")}</p>`;
    return `<ul class="edu-list">${itemsHtml}</ul><p class="edu-empty edu-filter-empty" hidden>${escapeHtml(empty || "Nothing here")}</p>`;
  }

  function paintAssignmentFilters() {
    document.querySelectorAll(".edu-filter").forEach((label) => {
      const input = label.querySelector("input[data-filter]");
      const tag = input && input.getAttribute("data-filter");
      if (!tag) return;
      const on = typeFilter.has(tag);
      label.classList.toggle("is-on", on);
      input.checked = on;
    });
    document.querySelectorAll(".edu-row[data-tag]").forEach((row) => {
      const tag = row.getAttribute("data-tag") || "HW";
      row.classList.toggle("is-filter-hidden", !typeFilter.has(tag));
    });
    applyCollapseHidden("lg-edu-todo", todoExpanded, TODOS_COLLAPSED_LIMIT);
    document.querySelectorAll(".edu-list").forEach((list) => {
      const rows = [...list.querySelectorAll(":scope > .edu-row[data-tag]")];
      if (!rows.length) return;
      const visible = rows.some(
        (row) =>
          !row.classList.contains("is-filter-hidden") &&
          !row.classList.contains("is-collapse-hidden")
      );
      list.classList.toggle("is-filter-empty", !visible);
      const empty = list.nextElementSibling;
      if (empty && empty.classList.contains("edu-filter-empty")) {
        empty.hidden = visible;
      }
    });
  }

  function applyCollapseHidden(filterId, expanded, limit) {
    const panel = document.querySelector(`[data-filter-id="${filterId}"]`);
    if (!panel) return;
    const rows = [...panel.querySelectorAll(".edu-row[data-tag]")];
    rows.forEach((row) => row.classList.remove("is-collapse-hidden"));
    if (expanded) return;
    rows
      .filter((row) => !row.classList.contains("is-filter-hidden"))
      .slice(limit)
      .forEach((row) => row.classList.add("is-collapse-hidden"));
  }

  function assignmentById(id) {
    const key = String(id || "");
    return (lastHome.assignments || []).find((t) => String(t.id || t.canvasId || "") === key) || null;
  }

  function ensureCompletedList() {
    const panel = document.querySelector('[data-filter-id="lg-edu-completed"]');
    if (!panel) return null;
    let list = panel.querySelector(".edu-list");
    if (list) return list;
    list = document.createElement("ul");
    list.className = "edu-list";
    const empty = [...panel.querySelectorAll(":scope > .edu-empty, :scope > .edu-list + .edu-empty")];
    const firstEmpty = panel.querySelector(":scope > .edu-empty");
    if (firstEmpty) firstEmpty.replaceWith(list);
    else panel.appendChild(list);
    if (!list.nextElementSibling || !list.nextElementSibling.classList.contains("edu-filter-empty")) {
      const filterEmpty = document.createElement("p");
      filterEmpty.className = "edu-empty edu-filter-empty";
      filterEmpty.hidden = true;
      filterEmpty.textContent = "Nothing completed yet";
      list.after(filterEmpty);
    }
    empty.forEach((node) => {
      if (node.isConnected && node.classList.contains("edu-empty") && !node.classList.contains("edu-filter-empty")) {
        node.remove();
      }
    });
    return list;
  }

  function refreshTodoEmptyState() {
    const panel = document.querySelector('[data-filter-id="lg-edu-todo"]');
    if (!panel) return;
    const list = panel.querySelector(".edu-list");
    if (!list) return;
    const visible = [...list.querySelectorAll(":scope > .edu-todo")].some(
      (row) =>
        !row.classList.contains("is-filter-hidden") &&
        !row.classList.contains("is-collapse-hidden") &&
        !row.classList.contains("is-done")
    );
    list.classList.toggle("is-filter-empty", !visible);
    let empty = list.nextElementSibling;
    if (!empty || !empty.classList.contains("edu-filter-empty")) {
      empty = document.createElement("p");
      empty.className = "edu-empty edu-filter-empty";
      empty.textContent = me?.canvasConnected ? "No open work" : "Connect Canvas in settings";
      list.after(empty);
    }
    empty.hidden = visible;
  }

  function completeTodoRow(check) {
    const row = check.closest(".edu-todo");
    const id = check.getAttribute("data-todo-id") || row?.getAttribute("data-id");
    if (!row || !id || check.classList.contains("is-checked") || row.dataset.busy === "1") return;
    const item = assignmentById(id);
    row.dataset.busy = "1";
    check.classList.add("is-checked");
    check.setAttribute("aria-label", "Completed");
    check.disabled = true;
    row.classList.add("is-done");
    if (item) item.done = true;

    const dest = ensureCompletedList();
    if (!dest) {
      row.dataset.busy = "";
      return;
    }

    const first = row.getBoundingClientRect();
    dest.appendChild(row);
    const last = row.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    row.classList.add("is-flying");
    row.style.transform = `translate(${dx}px, ${dy}px)`;
    row.style.transition = "none";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        row.style.transition = "transform 0.48s cubic-bezier(0.22, 1, 0.36, 1)";
        row.style.transform = "translate(0, 0)";
      });
    });
    const finish = () => {
      if (row.dataset.busy !== "1") return;
      row.classList.remove("is-flying");
      row.style.transition = "";
      row.style.transform = "";
      row.dataset.busy = "";
      refreshTodoEmptyState();
      paintAssignmentFilters();
    };
    row.addEventListener(
      "transitionend",
      (ev) => {
        if (ev.propertyName && ev.propertyName !== "transform") return;
        finish();
      },
      { once: true }
    );
    window.setTimeout(finish, 700);

    api(`/v1/me/canvas/assignments/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      body: JSON.stringify({
        canvasId: item?.canvasId || id,
        plannerOverrideId: item?.plannerOverrideId || "",
        plannableType: item?.plannableType || "assignment",
      }),
      timeoutMs: 15000,
    })
      .then((saved) => {
        if (item && saved?.plannerOverrideId) item.plannerOverrideId = saved.plannerOverrideId;
      })
      .catch(() => {
        /* local complete still stands for the demo */
      });
  }

  function trimNum(n) {
    const v = typeof n === "number" ? n : Number(String(n || "").replace(/%/g, "").trim());
    if (!Number.isFinite(v)) return "";
    return String(Math.round(v * 10) / 10);
  }

  function scoreNumber(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const n = Number(String(v || "").replace(/%/g, "").replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }

  function letterFromPercent(score) {
    const n = scoreNumber(score);
    if (n == null) return "";
    if (n >= 93) return "A";
    if (n >= 90) return "A-";
    if (n >= 87) return "B+";
    if (n >= 83) return "B";
    if (n >= 80) return "B-";
    if (n >= 77) return "C+";
    if (n >= 73) return "C";
    if (n >= 70) return "C-";
    if (n >= 67) return "D+";
    if (n >= 63) return "D";
    if (n >= 60) return "D-";
    return "F";
  }

  function normalizeCourseName(raw) {
    return String(raw || "")
      .toLowerCase()
      .replace(/\./g, "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b(fall|winter|spring|year)\b/g, " ")
      .replace(/\d{4}-\d{2}\S*/g, " ")
      .replace(/:[a-z][a-z0-9_-]*$/i, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function periodLetter(period) {
    const p = String(period || "").trim().toUpperCase();
    return /^[A-H]$/.test(p) ? p : "";
  }

  function hashTone(raw) {
    const s = String(raw || "class");
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return TONE_CYCLE[h % TONE_CYCLE.length];
  }

  function classTone(klass) {
    const letter = periodLetter(klass?.period);
    if (PERIOD_TONES[letter]) return PERIOD_TONES[letter];
    return hashTone(klass?.id || klass?.canvasCourseId || klass?.courseId || klass?.name || "");
  }

  function cardClass(tone) {
    const key = TONE_CYCLE.includes(tone) ? tone : "slate";
    return `edu-card edu-tone-${key}`;
  }

  function classForWork(item) {
    return (
      (lastHome.classes || []).find((c) => classMatchesWork(c, item)) ||
      (lastHome.courses || []).find((c) => classMatchesWork(c, item)) ||
      null
    );
  }

  function workTone(item) {
    const klass = classForWork(item);
    if (klass) return classTone(klass);
    return hashTone(item?.courseId || item?.courseName || "");
  }

  function isLetterGrade(raw) {
    return /^[ABCDF][+-]?$/i.test(String(raw || "").trim());
  }

  function courseBlob(course) {
    return normalizeCourseName(`${course?.name || ""} ${course?.courseCode || ""}`);
  }

  function isNonGradeCourse(course) {
    const n = courseBlob(course);
    if (!n) return false;
    if (/\bpeer\s*mentor(s|ing)?\b/.test(n)) return true;
    if (/\b(eps\s+)?library\b/.test(n)) return true;
    if (/\b(advisor|advisory)\b/.test(n)) return true;
    if (/\bclass of \d{4}\b/.test(n)) return true;
    return false;
  }

  function isHiddenClassCourse(course) {
    const n = courseBlob(course);
    if (!n) return false;
    if (/\b(eps\s+)?library\b/.test(n)) return true;
    if (/\b(advisor|advisory)\b/.test(n)) return true;
    if (/\bclass of \d{4}\b/.test(n)) return true;
    return false;
  }

  function courseNamesMatch(className, courseName) {
    const dash = normalizeCourseName(className);
    const canvas = normalizeCourseName(courseName);
    if (!dash || !canvas) return false;
    if (dash === canvas) return true;
    if (!canvas.includes(dash) && !dash.includes(canvas)) return false;
    const numA = dash.match(/\b(\d+)\s*$/);
    const numB = canvas.match(/\b(\d+)\s*$/);
    if (numA || numB) return Boolean(numA && numB && numA[1] === numB[1]);
    return true;
  }

  function periodTagHtml(period) {
    const letter = periodLetter(period);
    return letter ? `<span class="edu-tag edu-period">${escapeHtml(letter)}</span>` : "";
  }

  function formatCourseGrade(row) {
    let score = scoreNumber(row?.currentScore);
    let letter = isLetterGrade(row?.currentGrade) ? String(row.currentGrade).trim() : "";
    // Canvas final scores treat missing work as 0. That is not the grade page.
    if (score === 0 && !letter) score = null;
    if (score != null && !letter) letter = letterFromPercent(score);
    const pct = score != null ? `${trimNum(score)}%` : "";
    if (letter && pct) return `${letter} ${pct}`;
    return letter || pct || "—";
  }

  function formatWorkScore(w) {
    if (w?.excused) return "Excused";
    if (w?.missing && w.score == null) return "Missing";
    if (w?.score == null && w?.submitted) return "Submitted";
    if (w?.score == null) return "—";
    const pts = typeof w.pointsPossible === "number" ? `/${trimNum(w.pointsPossible)}` : "";
    const letter = w.grade && String(w.grade) !== String(w.score) ? ` ${w.grade}` : "";
    return `${trimNum(w.score)}${pts}${letter}`;
  }

  function prettyCourseName(raw) {
    return String(raw || "")
      .replace(/\s*\([^)]*\)/g, " ")
      .replace(/\s*\d{4}-\d{2}\S*/g, " ")
      .replace(/\s*:[a-z][a-z0-9_-]*$/i, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function fullerClassName(scheduleName, canvasName) {
    const a = String(scheduleName || "").trim();
    const b = prettyCourseName(canvasName);
    if (a && b && courseNamesMatch(a, b) && b.length > a.length) return b;
    return a || b;
  }

  function gradeForClass(klass) {
    const ids = [
      klass?.canvasCourseId,
      klass?.courseId,
      klass?.id,
    ].map((v) => String(v || "")).filter(Boolean);
    const rows = [...(lastHome.grades || []), ...(lastHome.courses || [])];
    return (
      rows.find((c) => ids.includes(String(c.id || ""))) ||
      rows.find((c) => courseNamesMatch(klass?.name, c.name)) ||
      null
    );
  }

  function homeGradeItems() {
    const raw = (lastHome.grades || []).length ? lastHome.grades : lastHome.courses || [];
    const scheduled = (lastHome.classes || []).filter((c) => !c.freePeriod && !isNonGradeCourse(c));
    if (scheduled.length) {
      return scheduled.map((klass) => {
        const g = gradeForClass(klass) || {};
        return {
          ...g,
          id: g.id || klass.id,
          name: fullerClassName(klass.name, g.name),
          period: periodLetter(klass.period),
          currentScore: g.currentScore,
          currentGrade: g.currentGrade,
          work: g.work,
        };
      });
    }
    return raw
      .filter((c) => !isNonGradeCourse(c))
      .map((c) => ({ ...c, period: periodLetter(c.period) }));
  }

  function gradeRow(c) {
    return `<li class="edu-row edu-class-row ${cardClass(classTone(c))}">
      <a class="edu-row-link" data-route href="/grades">
        <span class="edu-name">${periodTagHtml(c.period)}<span class="edu-hero-class-name">${escapeHtml(c.name)}</span></span>
        <span class="edu-meta edu-grade">${escapeHtml(formatCourseGrade(c))}</span>
      </a>
    </li>`;
  }

  function workRow(w, tone) {
    const tag = w.tag || "HW";
    const href = w.canvasLink || "#";
    const late = w.late ? " is-late" : "";
    return `<li class="edu-row${late} ${cardClass(tone || workTone(w))}">
      <a class="edu-row-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">
        <span class="edu-name"><span class="edu-tag edu-tag-${escapeHtml(tag)}">${escapeHtml(tag)}</span> ${escapeHtml(w.title)}</span>
        <span class="edu-meta edu-grade">${escapeHtml(formatWorkScore(w))}</span>
      </a>
    </li>`;
  }

  function formatDue(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function todoRow(t) {
    const tag = t.tag || "HW";
    const due = t.due ? `<span class="edu-meta">${escapeHtml(formatDue(t.due))}</span>` : "";
    const klass = t.courseName ? `<span class="edu-meta">${escapeHtml(t.courseName)}</span>` : "";
    const href = t.canvasLink || "#";
    return `<li class="edu-row edu-todo${t.done ? " is-done" : ""} ${cardClass(workTone(t))}" data-id="${escapeHtml(t.id || t.canvasId || "")}" data-tag="${escapeHtml(tag)}">
      <button type="button" class="edu-check${t.done ? " is-checked" : ""}" data-liquid-glass="circle" data-filter-id="lg-check-${escapeHtml(t.id)}" data-todo-id="${escapeHtml(t.id || t.canvasId || "")}" aria-label="${t.done ? "Completed" : "Mark complete"}"${t.done ? " disabled" : ""}><span class="edu-check-dot"></span></button>
      <a class="edu-row-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">
        <span class="edu-name"><span class="edu-tag edu-tag-${escapeHtml(tag)}">${escapeHtml(tag)}</span> ${escapeHtml(t.title)}</span>
        ${klass}${due}
      </a>
    </li>`;
  }

  function classHref(c) {
    const id = c && (c.id || c.courseId);
    return id ? `/class/${encodeURIComponent(id)}` : "/";
  }

  function isCurrentClass(c) {
    const period = String(c?.period || "").toUpperCase();
    const meeting = (lastHome.meetings || []).find((m) => m.current && String(m.period || "").toUpperCase() === period);
    if (meeting) {
      if (c.id && meeting.classId) return meeting.classId === c.id;
      return true;
    }
    const cur = currentPeriod();
    const p = period;
    return Boolean(cur && p && (p === cur[2] || p === cur[3]));
  }

  function classRow(c) {
    const highlight = isCurrentClass(c);
    const href = classHref(c);
    const meta = c.courseCode || "";
    return `<li class="edu-row edu-class-row${highlight ? " is-current" : ""} ${cardClass(classTone(c))}">
      <a class="edu-row-link" data-route href="${escapeHtml(href)}">
        <span class="edu-name">${periodTagHtml(c.period)}<span class="edu-hero-class-name">${escapeHtml(fullerClassName(c.name, gradeForClass(c)?.name))}</span></span>
        <span class="edu-meta">${escapeHtml(meta)}</span>
      </a>
    </li>`;
  }

  function fileHref(f) {
    if (f.dataUrl) return f.dataUrl;
    if (f.webUrl) return f.webUrl;
    if (String(f.id || "").startsWith("local:")) return "#";
    return `${apiBase}/v1/me/onedrive/file?id=${encodeURIComponent(f.id || "")}`;
  }

  function fileTile(f, i) {
    const href = fileHref(f);
    const vault = String(f.id || "").startsWith("vault:");
    const vaultAttr = vault ? ` data-vault-id="${escapeHtml(f.id)}"` : "";
    return `<a class="edu-file-tile" href="${escapeHtml(href)}" target="_blank" rel="noopener" data-filter-id="lg-file-${i}" title="${escapeHtml(f.name)}"${vaultAttr}><span class="edu-file-name">${escapeHtml(f.name)}</span></a>`;
  }

  function filesToolsHtml() {
    return `<div class="edu-files-tools">
      <button type="button" class="edu-sheet-btn" data-file-upload data-liquid-glass="rounded" data-filter-id="lg-edu-file-up">Upload</button>
      <a class="set-link" href="${OD_WEB}" target="_blank" rel="noopener">Open OneDrive</a>
      <p class="edu-empty" id="onedrive-upload-status"></p>
    </div>`;
  }

  function filesPanelBody(tiles, emptyText, errorText) {
    const grid = tiles
      ? `<div class="edu-files">${tiles}</div>`
      : `<p class="edu-empty">${escapeHtml(emptyText)}</p>`;
    const err = errorText ? `<p class="edu-empty">${escapeHtml(errorText)}</p>` : "";
    return `${grid}${err}${filesToolsHtml()}`;
  }

  function formatMailWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function mailRow(m) {
    const unread = m.unread ? " edu-mail-unread" : "";
    const who = m.fromAddress || m.from || "";
    const open = m.webLink
      ? `<a class="set-link edu-mail-open-web" href="${escapeHtml(m.webLink)}" target="_blank" rel="noopener">Open</a>`
      : "";
    return `<li class="edu-row${unread}">
      <button type="button" class="edu-row-link" data-mail-id="${escapeHtml(m.id)}" style="all:unset;cursor:pointer;display:block;width:100%">
        <span class="edu-name">${escapeHtml(m.subject || "(no subject)")}</span>
        <span class="edu-meta">${escapeHtml(who)} · ${escapeHtml(formatMailWhen(m.received))}</span>
      </button>
      ${open}
    </li>`;
  }

  function mailComposeHtml(mode) {
    const sendLabel = mailBusy ? "Sending…" : "Send";
    return `<form class="edu-compose" id="outlook-compose" data-mail-mode="${escapeHtml(mode)}">
        <input id="outlook-to" name="to" type="text" placeholder="To (comma-separated)" required />
        <input id="outlook-subject" name="subject" placeholder="Subject" required maxlength="200" />
        <textarea id="outlook-body" name="body" placeholder="Message" required maxlength="8000"></textarea>
        <button type="submit" class="edu-sheet-btn edu-sheet-btn--gold" data-liquid-glass="rounded" data-filter-id="lg-edu-ol-send"${mailBusy ? " disabled" : ""}>${sendLabel}</button>
        <p class="edu-empty" id="outlook-send-status"></p>
      </form>`;
  }

  function eventsThisWeek(events) {
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const day = start.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + mondayOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return (events || [])
      .filter((e) => {
        const t = new Date(e.start);
        return !Number.isNaN(t.getTime()) && t >= start && t < end;
      })
      .slice(0, 3);
  }

  function formatEventLine(e) {
    const d = new Date(e.start);
    const when = Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
    const subject = e.subject || "Event";
    return when ? `${when} · ${subject}` : subject;
  }

  function mailWeekHtml(events) {
    const lines = eventsThisWeek(events)
      .map((e) => `<p>${escapeHtml(formatEventLine(e))}</p>`)
      .join("");
    return lines ? `<div class="edu-mail-week">${lines}</div>` : "";
  }

  const MAIL_TODO_RE = /due|homework|assignment|quiz|test|project|exam/i;

  function mailTodoItems(messages, assignments) {
    const titles = new Set(
      (assignments || []).map((a) => String(a.title || "").trim().toLowerCase()).filter(Boolean)
    );
    const hits = [];
    for (const m of messages || []) {
      const sub = String(m.subject || "").trim();
      if (!MAIL_TODO_RE.test(sub)) continue;
      if (titles.has(sub.toLowerCase())) continue;
      hits.push(m);
      if (hits.length >= 5) break;
    }
    return hits;
  }

  function mailTodoRow(m) {
    return `<li class="edu-row edu-todo">
      <span class="edu-check" aria-hidden="true"><span class="edu-check-dot"></span></span>
      <button type="button" class="edu-row-link" data-mail-id="${escapeHtml(m.id)}" style="all:unset;cursor:pointer;display:block;width:100%">
        <span class="edu-name">${escapeHtml(m.subject || "(no subject)")}</span>
        <span class="edu-meta">Mail</span>
      </button>
    </li>`;
  }

  function outlookWebLink() {
    return `<a class="set-link" href="${OL_WEB}" target="_blank" rel="noopener">Open school Outlook</a>`;
  }

  function mailPanelHtml(messages) {
    const week = mailWeekHtml(lastHome.events);
    const err = lastHome.mailError ? `<p class="edu-empty">${escapeHtml(lastHome.mailError)}</p>` : "";
    const rows = (messages || []).map(mailRow).join("");
    const list = rows
      ? `<ul class="edu-list">${rows}</ul>`
      : `<p class="edu-empty">Open Outlook, or save a message in settings</p>`;
    const open = openMail
      ? `<div class="edu-mail-open">
          <p class="edu-name">${escapeHtml(openMail.subject || "")}</p>
          <p class="edu-meta">${escapeHtml(openMail.from || "")}</p>
          ${
            openMail.webLink
              ? `<a class="set-link" href="${escapeHtml(openMail.webLink)}" target="_blank" rel="noopener">Open</a>`
              : ""
          }
          <pre class="edu-mail-body">${escapeHtml(openMail.body || openMail.preview || "")}</pre>
        </div>`
      : "";
    return `${week}${err}${list}${open}${outlookWebLink()}${mailComposeHtml("mailto")}`;
  }

  function classMailHtml(klass) {
    const hint = String(klass?.name || "").toLowerCase();
    const messages = (lastHome.messages || []).filter((m) => {
      if (!hint) return false;
      const blob = `${m.subject || ""} ${m.from || ""} ${m.fromAddress || ""} ${m.preview || ""}`.toLowerCase();
      return blob.includes(hint);
    });
    if (!messages.length) {
      return `<p class="edu-empty">No saved mail for this class</p>${outlookWebLink()}`;
    }
    return `<ul class="edu-list">${messages.slice(0, 8).map(mailRow).join("")}</ul>`;
  }

  function homeClasses() {
    const scheduled = (lastHome.classes || []).filter((c) => !c.freePeriod && !isHiddenClassCourse(c));
    if (scheduled.length) return scheduled;
    return (lastHome.courses || []).filter((c) => !isHiddenClassCourse(c));
  }

  function notesPanelHtml() {
    const rows = (lastHome.notes || [])
      .slice(0, 8)
      .map((n) => {
        const href = `/note/${encodeURIComponent(n.id)}`;
        return `<li class="edu-row">
          <a class="edu-row-link" data-route href="${escapeHtml(href)}">
            <span class="edu-name">${escapeHtml(n.title || n.subject || "Note")}</span>
            <span class="edu-meta">${escapeHtml(n.subject || "")}</span>
          </a>
        </li>`;
      })
      .join("");
    const list = rows
      ? `<ul class="edu-list">${rows}</ul>`
      : `<p class="edu-empty">Paste a note and save it</p>`;
    return `${list}
      <form class="edu-notes-form" id="notes-classify">
        <textarea id="note-text" name="text" maxlength="12000" placeholder="Paste class notes" required></textarea>
        <button type="submit" class="edu-sheet-btn edu-sheet-btn--gold" data-liquid-glass="rounded" data-filter-id="lg-edu-note-go">Classify</button>
        <p class="edu-empty" id="note-status"></p>
      </form>`;
  }

  function renderHome(next = lastHome) {
    lastHome = {
      ...lastHome,
      courses: next.courses ?? lastHome.courses ?? [],
      assignments: next.assignments ?? lastHome.assignments ?? [],
      files: next.files ?? lastHome.files ?? [],
      filesError: next.filesError != null ? next.filesError : lastHome.filesError || "",
      messages: next.messages ?? lastHome.messages ?? [],
      mailError: next.mailError != null ? next.mailError : lastHome.mailError || "",
      events: next.events ?? lastHome.events ?? [],
      classes: next.classes ?? lastHome.classes ?? [],
      meetings: next.meetings ?? lastHome.meetings ?? [],
      notes: next.notes ?? lastHome.notes ?? [],
      grades: next.grades ?? lastHome.grades ?? [],
    };
    const open = (lastHome.assignments || []).filter((t) => !t.done);
    const done = (lastHome.assignments || []).filter((t) => t.done);
    const todoRows = open.map(todoRow).join("");
    const classItems = homeClasses();

    const todoEmpty = me?.canvasConnected
      ? "No open work"
      : "Connect Canvas in settings";
    const classEmpty = classItems.length
      ? "No classes"
      : "Upload a term schedule PDF in settings";
    const gradeItems = homeGradeItems();
    const gradeEmpty = me?.canvasConnected
      ? "No course grades yet"
      : "Connect Canvas in settings";

    appEl.classList.add("is-settled");
    appEl.innerHTML = `
      <p class="edu-home-mark">EPSynapse</p>
      <div class="edu-grid edu-grid--home">
        <div class="edu-col edu-col--main">
          ${panelHtml("TODO", listOrEmpty(todoRows, todoEmpty), "lg-edu-todo", "", todoExpanded ? filterBarHtml("todo") : "", collapseTitle("TODO", todoExpanded))}
          ${panelHtml("Completed", listOrEmpty(done.map(todoRow).join(""), "Nothing completed yet"), "lg-edu-completed", "edu-panel--completed")}
        </div>
        <div class="edu-col edu-col--side">
          ${panelHtml("Classes", listOrEmpty(classItems.map(classRow).join(""), classEmpty), "lg-edu-classes")}
          ${panelHtml("Grades", listOrEmpty(gradeItems.map(gradeRow).join(""), gradeEmpty), "lg-edu-grades")}
          ${panelHtml("Notes", notesPanelHtml(), "lg-edu-notes", "edu-panel--notes")}
        </div>
      </div>
    `;
    if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
    paintAssignmentFilters();
  }

  function classMatchesWork(klass, item) {
    if (!klass || !item) return false;
    const courseId = String(klass.canvasCourseId || klass.courseId || "");
    if (courseId && String(item.courseId || "") === courseId) return true;
    return courseNamesMatch(klass.name, item.courseName);
  }

  function findClass(id) {
    const key = String(id || "");
    return (
      (lastHome.classes || []).find((c) => String(c.id) === key) ||
      (lastHome.courses || []).find((c) => String(c.id) === key) ||
      null
    );
  }

  function nextMeetingLine(klass) {
    const meetings = lastHome.meetings || [];
    const period = String(klass?.period || "").toUpperCase();
    const mine = meetings.filter((m) => {
      if (klass?.id && m.classId) return m.classId === klass.id;
      return period && String(m.period || "").toUpperCase() === period;
    });
    const current = mine.find((m) => m.current);
    if (current) return `In session now · ${current.start}–${current.end}`;
    const next = mine[0];
    if (next?.start) return `Next · ${next.start}–${next.end}`;
    return "";
  }

  function renderClass(id) {
    const klass = findClass(id);
    if (!klass) {
      appEl.classList.add("is-settled");
      appEl.innerHTML = `
        <p class="edu-home-mark"><a class="edu-home-research" data-route href="/">Home</a></p>
        <p class="edu-empty">No class with that id. Upload a term schedule PDF or connect Canvas.</p>
      `;
      return;
    }
    const work = (lastHome.assignments || []).filter((t) => classMatchesWork(klass, t));
    const open = work.filter((t) => !t.done);
    const done = work.filter((t) => t.done);
    const nameHint = String(klass.name || "").toLowerCase();
    const notes = (lastHome.notes || []).filter((n) => {
      if (n.classId && n.classId === klass.id) return true;
      if (klass.subject && n.subject === klass.subject) return true;
      const title = String(n.title || "").toLowerCase();
      return nameHint && title.includes(nameHint);
    });
    const noteRows = notes
      .map((n) => {
        const href = `/note/${encodeURIComponent(n.id)}`;
        return `<li class="edu-row">
          <a class="edu-row-link" data-route href="${escapeHtml(href)}">
            <span class="edu-name">${escapeHtml(n.title || n.subject || "Note")}</span>
            <span class="edu-meta">${escapeHtml(n.subject || "")}</span>
          </a>
        </li>`;
      })
      .join("");

    const period = periodLetter(klass.period)
      ? `<span class="edu-tag edu-period edu-period--hero">${escapeHtml(periodLetter(klass.period))}</span>`
      : "";
    const next = nextMeetingLine(klass);
    const courseGrade = gradeForClass(klass);
    const gradeText = courseGrade ? formatCourseGrade(courseGrade) : "";
    const sub = [klass.subject, klass.courseCode, gradeText && gradeText !== "—" ? gradeText : "", next]
      .filter(Boolean)
      .join(" · ");
    appEl.classList.add("is-settled");
    appEl.innerHTML = `
      <p class="edu-home-mark"><a class="edu-home-research" data-route href="/">Home</a></p>
      <header class="edu-hero edu-hero--detail edu-hero--detail-canvas edu-hero--class ${cardClass(classTone(klass))}">
        <div class="edu-hero-lead">
          <h1 class="edu-hero-title edu-hero-title--class">${period}<span class="edu-hero-class-name">${escapeHtml(fullerClassName(klass.name, courseGrade?.name))}</span></h1>
          <p class="edu-hero-sub">${escapeHtml(sub)}</p>
        </div>
      </header>
      <div class="edu-grid edu-grid--home">
        <div class="edu-col edu-col--main">
          ${panelHtml("TODO", listOrEmpty(open.map(todoRow).join(""), "No open work for this class"), "lg-edu-todo", "", todoExpanded ? filterBarHtml("todo") : "", collapseTitle("TODO", todoExpanded))}
          ${panelHtml("Completed", listOrEmpty(done.map(todoRow).join(""), "Nothing completed yet"), "lg-edu-completed", "edu-panel--completed")}
        </div>
        <div class="edu-col edu-col--side">
          ${panelHtml("Notes", listOrEmpty(noteRows, "No notes for this class yet"), "lg-edu-class-notes")}
        </div>
      </div>
    `;
    if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
    paintAssignmentFilters();
  }

  function subjectOptions(selected) {
    const labels = [
      "Mathematics",
      "Physics",
      "Chemistry",
      "Biology",
      "Computer Science",
      "History",
      "Literature",
      "Economics",
      "Other",
    ];
    return labels
      .map((s) => `<option value="${escapeHtml(s)}"${s === selected ? " selected" : ""}>${escapeHtml(s)}</option>`)
      .join("");
  }

  function renderNote(id) {
    const note = (lastHome.notes || []).find((n) => String(n.id) === String(id));
    if (!note) {
      appEl.classList.add("is-settled");
      appEl.innerHTML = `
        <p class="edu-home-mark"><a class="edu-home-research" data-route href="/">Home</a></p>
        <p class="edu-empty">That note is not on this account.</p>
      `;
      return;
    }
    const gold = note.userGoldSubject || note.subject || "";
    appEl.classList.add("is-settled");
    appEl.innerHTML = `
      <p class="edu-home-mark"><a class="edu-home-research" data-route href="/">Home</a></p>
      <header class="edu-hero edu-hero--detail">
        <div class="edu-hero-lead">
          <h1 class="edu-hero-title">${escapeHtml(note.title || "Note")}</h1>
          <p class="edu-hero-sub">${escapeHtml(note.subject || "Unclassified")}</p>
        </div>
      </header>
      <div class="edu-grid edu-grid--home">
        <div class="edu-col edu-col--main">
          ${panelHtml("Note", `<pre class="edu-note-body">${escapeHtml(note.text || "")}</pre>`, "lg-edu-note-text")}
        </div>
        <div class="edu-col edu-col--side">
          ${panelHtml(
            "Subject",
            `<form class="edu-notes-form" id="note-gold">
              <label for="note-subject">Correct subject</label>
              <select id="note-subject" name="subject">${subjectOptions(gold)}</select>
              <button type="submit" class="edu-sheet-btn edu-sheet-btn--gold" data-liquid-glass="rounded" data-filter-id="lg-edu-note-gold">Save</button>
              <p class="edu-empty" id="note-gold-status"></p>
            </form>`,
            "lg-edu-note-gold"
          )}
        </div>
      </div>
    `;
    if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
  }

  async function ensureNote(id) {
    const existing = (lastHome.notes || []).find(
      (n) => String(n.id) === String(id) && n.text
    );
    if (existing) return existing;
    try {
      const data = await api(`/v1/me/notes/${encodeURIComponent(id)}`);
      const note = data.note || data;
      if (!note?.id) return null;
      lastHome.notes = [note, ...(lastHome.notes || []).filter((n) => n.id !== note.id)];
      return note;
    } catch {
      return null;
    }
  }

  async function ensureGrades(detail) {
    if (!me?.canvasConnected) return [];
    if (detail) {
      const haveWork = (lastHome.grades || []).some((g) => Array.isArray(g.work));
      if (haveWork) return lastHome.grades;
      try {
        const data = await api("/v1/me/canvas/grades?work=1", { timeoutMs: 25000 });
        lastHome.grades = data.grades || [];
        return lastHome.grades;
      } catch {
        return lastHome.grades || lastHome.courses || [];
      }
    }
    if ((lastHome.grades || []).length) return lastHome.grades;
    if ((lastHome.courses || []).length) return lastHome.courses;
    try {
      const data = await api("/v1/me/canvas/grades");
      lastHome.grades = data.grades || [];
      return lastHome.grades;
    } catch {
      return lastHome.courses || [];
    }
  }

  function decorateGradeRows(grades) {
    const incoming = grades || [];
    const haveWork = incoming.some((g) => Array.isArray(g.work));
    const source = haveWork || !homeGradeItems().length ? incoming : homeGradeItems();
    return source
      .filter((c) => !isNonGradeCourse(c))
      .map((c) => {
        const scheduled = (lastHome.classes || []).find(
          (k) =>
            !k.freePeriod &&
            !isNonGradeCourse(k) &&
            (String(k.id) === String(c.id) || courseNamesMatch(k.name, c.name))
        );
        return {
          ...c,
          name: fullerClassName(scheduled?.name, c.name),
          period: periodLetter(scheduled?.period || c.period),
        };
      });
  }

  function renderGradesView(grades) {
    const rows = decorateGradeRows(grades);
    const empty = me?.canvasConnected
      ? "Canvas has not posted grades for these classes yet."
      : "Connect Canvas in settings";
    const panels = rows
      .map((g) => {
        const title = [periodLetter(g.period), g.name].filter(Boolean).join(" · ");
        const mark = `<span class="edu-grade-mark">${escapeHtml(formatCourseGrade(g))}</span>`;
        const body = g.work === undefined
          ? `<p class="edu-empty">Loading graded work…</p>`
          : listOrEmpty((g.work || []).map((w) => workRow(w, classTone(g))).join(""), "No graded work yet");
        return panelHtml(title, body, `lg-grade-${g.id}`, "", mark);
      })
      .join("");
    appEl.classList.add("is-settled");
    appEl.innerHTML = `
      <p class="edu-home-mark"><a class="edu-home-research" data-route href="/">Home</a></p>
      <div class="edu-grid edu-grid--grades">
        <div class="edu-col edu-col--main">
          ${panels || `<p class="edu-empty">${escapeHtml(empty)}</p>`}
        </div>
      </div>
    `;
    if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
  }

  async function renderGrades() {
    const cached = lastHome.grades || lastHome.courses || [];
    if (cached.length) renderGradesView(cached);
    const grades = await ensureGrades(true);
    renderGradesView(grades);
  }

  async function routeAndRender() {
    if (!signedInViaGoogle()) {
      applyAuthGate();
      return;
    }
    if (loading) loading.hidden = true;
    if (stage) stage.hidden = false;
    const route = currentRoute();
    if (route.page === "class") {
      renderClass(route.id);
      return;
    }
    if (route.page === "note") {
      await ensureNote(route.id);
      renderNote(route.id);
      return;
    }
    if (route.page === "grades") {
      await renderGrades();
      return;
    }
    renderHome(lastHome);
  }

  async function loadDashboard() {
    if (!signedInViaGoogle()) {
      applyAuthGate();
      return;
    }
    loading.hidden = true;
    stage.hidden = false;
    const courses = me?.canvasConnected
      ? api("/v1/me/canvas/courses").then((r) => r.courses || []).catch(() => [])
      : Promise.resolve([]);
    const gradeFetch = me?.canvasConnected
      ? api("/v1/me/canvas/grades").then((r) => r.grades || []).catch(() => [])
      : Promise.resolve([]);
    const assignments = me?.canvasConnected
      ? api("/v1/me/canvas/assignments").then((r) => r.assignments || []).catch(() => [])
      : Promise.resolve([]);
    const schedule = api("/v1/me/schedule")
      .then((r) => r)
      .catch(() => ({ classes: [], meetings: [] }));
    const notes = api("/v1/me/notes")
      .then((r) => r.notes || [])
      .catch(() => []);
    const sched = await schedule;
    const courseRows = await courses;
    const gradeRows = await gradeFetch;
    const gradeById = new Map((gradeRows || []).map((g) => [String(g.id), g]));
    const mergedCourses = courseRows.map((c) => {
      const g = gradeById.get(String(c.id));
      if (!g) return c;
      const a = scoreNumber(c.currentScore);
      const b = scoreNumber(g.currentScore);
      const currentScore = a == null ? b : b == null ? a : a === 0 && b !== 0 ? b : a;
      return {
        ...c,
        currentScore,
        currentGrade: c.currentGrade || g.currentGrade,
        finalScore: c.finalScore != null ? c.finalScore : g.finalScore,
        finalGrade: c.finalGrade || g.finalGrade,
        htmlUrl: c.htmlUrl || g.htmlUrl,
      };
    });
    lastHome = {
      courses: mergedCourses,
      assignments: await assignments,
      files: [],
      filesError: "",
      messages: [],
      mailError: "",
      events: [],
      classes: sched.classes || [],
      meetings: sched.meetings || [],
      notes: await notes,
      grades: (gradeRows.length ? gradeRows : mergedCourses).map((c) => ({ ...c, work: undefined })),
      classFiles: [],
      classFilesFor: "",
      classFilesError: "",
    };
    routeAndRender();
  }

  async function refreshClassFiles(klass) {
    const name = String(klass?.name || "").trim();
    if (!name) return;
    if (lastHome.classFilesFor === name || classFilesInFlight === name) return;
    classFilesInFlight = name;
    try {
      const r = await api(`/v1/me/onedrive/files?q=${encodeURIComponent(name)}`, { timeoutMs: 20000 });
      lastHome.classFiles = Array.isArray(r.files) ? r.files : [];
      lastHome.classFilesError = r.error || "";
      lastHome.classFilesFor = name;
    } catch (err) {
      lastHome.classFiles = [];
      lastHome.classFilesError = err.message || "Could not load files.";
      lastHome.classFilesFor = name;
    } finally {
      classFilesInFlight = "";
    }
    const route = currentRoute();
    if (route.page === "class" && String(route.id) === String(klass.id)) {
      renderClass(klass.id);
    }
  }

  function paintOnedrive() {
    if (!signedInViaGoogle()) {
      setStatus(odStatus, NEED_GOOGLE);
      paintNavSummaries();
      return;
    }
    const n = localFiles().length;
    setStatus(
      odStatus,
      lastOdError ||
        (n
          ? `${n} file${n === 1 ? "" : "s"} on Home. Open OneDrive or upload more.`
          : "School IT blocks app sign-in. Open OneDrive, or upload files here.")
    );
    paintNavSummaries();
  }

  function paintOutlook() {
    if (!signedInViaGoogle()) {
      setStatus(olStatus, NEED_GOOGLE);
      paintNavSummaries();
      return;
    }
    const mail = localMail().length;
    const ev = localEvents().length;
    const bits = [];
    if (mail) bits.push(`${mail} saved`);
    if (ev) bits.push(`${ev} calendar`);
    setStatus(
      olStatus,
      lastOlError ||
        (bits.length
          ? `${bits.join(", ")} on Home. Open Outlook to read the rest.`
          : "School IT blocks app sign-in. Open Outlook. Send uses your mail app.")
    );
    paintNavSummaries();
  }

  function paintCanvasToken() {
    const entry = document.getElementById("canvas-entry");
    const ready = document.getElementById("canvas-ready");
    const connected = Boolean(me && me.canvasConnected);
    const replacing = entry && entry.dataset.replace === "1";
    if (entry) entry.hidden = connected && !replacing;
    if (ready) ready.hidden = !connected;
    const steps = document.getElementById("canvas-steps");
    if (steps) steps.hidden = connected && !replacing;
    paintKeysSummary();
  }

  function refreshKeyStatus() {
    const hasKey = accountHasKey();
    const id = providerSel.value || (me && me.modelProvider) || localStorage.getItem(LS_PROV) || "groq";
    const entry = document.getElementById("key-entry");
    const ready = document.getElementById("key-ready");
    const readyLabel = document.getElementById("key-ready-label");
    const replacing = entry && entry.dataset.replace === "1";
    if (entry) entry.hidden = hasKey && !replacing;
    if (ready) ready.hidden = !hasKey;
    if (readyLabel) {
      readyLabel.textContent = hasKey ? id : "";
    }
    paintKeysSummary();
    const steps = document.getElementById("key-steps");
    if (steps) steps.hidden = hasKey && !replacing;
    if (hasKey && !replacing) {
      setStatus(keyStatus, "");
      return;
    }
    if (hasKey && replacing) {
      setStatus(keyStatus, "Paste a new key to replace the one on this account.");
      return;
    }
    setStatus(
      keyStatus,
      signedInViaGoogle()
        ? "Paste the gsk_ key here, tap Save key, wait until Chat key says Groq, then ask in the pill."
        : ""
    );
  }

  function fillProviders(list) {
    providerSel.innerHTML = "";
    (list || []).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label + (p.recommended ? " · recommended" : "");
      providerSel.appendChild(opt);
    });
    const chosen = (me && me.modelProvider) || localStorage.getItem(LS_PROV) || "groq";
    if ([].some.call(providerSel.options, (o) => o.value === chosen)) {
      providerSel.value = chosen;
    }
    localStorage.setItem(LS_PROV, providerSel.value || chosen);
    document.documentElement.dataset.modelProvider = providerSel.value || chosen;
  }

  async function boot() {
    try {
      const runtime = await fetch("/runtime-config.json", { cache: "no-store" }).then((r) => r.json());
      const host = location.hostname;
      apiBase =
        host === "localhost" || host === "127.0.0.1"
          ? runtime.localApiBase || "http://127.0.0.1:3006"
          : runtime.apiBase || "";
      window.__epsynapseApiBase = apiBase;
    } catch {
      apiBase = "http://127.0.0.1:3006";
      window.__epsynapseApiBase = apiBase;
    }

    try {
      const cfg = await api("/v1/agent/config");
      fillProviders(cfg.providers);
    } catch {
      fillProviders([
        { id: "groq", label: "Groq", recommended: true },
        { id: "gemini", label: "Gemini" },
        { id: "openrouter", label: "OpenRouter" },
      ]);
    }
    refreshKeyStatus();

    const fromHash = await consumeGoogleHash();
    if (!fromHash) {
      try {
        me = await api("/v1/me");
        fillFormFromMe();
        await migrateLocalKey();
        await loadDashboard();
      } catch {
        me = null;
        loading.hidden = true;
        stage.hidden = true;
      }
    }
    paintAccount();
    paintCanvasToken();
    paintOnedrive();
    paintOutlook();
    await initGoogle();
  }

  window.addEventListener("popstate", () => {
    routeAndRender();
  });

  document.getElementById("home-open").addEventListener("click", goHome);

  function setScheduleStatus(msg) {
    const status = document.getElementById("schedule-status");
    if (status) status.textContent = msg || "";
  }

  async function uploadSchedulePdf() {
    if (!signedInViaGoogle()) {
      setScheduleStatus(NEED_GOOGLE);
      return;
    }
    const input = document.getElementById("schedulePdf");
    const file = input && input.files && input.files[0];
    if (!file) {
      setScheduleStatus("Choose a term schedule PDF first.");
      return;
    }
    setScheduleStatus(`Uploading ${file.name}…`);
    const body = new FormData();
    body.append("pdf", file, file.name);
    try {
      const headers = { Accept: "application/json" };
      const session = sid();
      if (session) headers["X-EPSynapse-Session"] = session;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      let res;
      try {
        res = await fetch(`${apiBase}/v1/me/schedule/pdf`, {
          method: "POST",
          credentials: "include",
          headers,
          body,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { error: text.slice(0, 200) };
      }
      if (!res.ok) throw new Error(payload.error || "Upload failed.");
      lastHome.classes = payload.classes || [];
      lastHome.meetings = payload.meetings || [];
      const count = (payload.classes || []).filter((c) => !c.freePeriod).length;
      setScheduleStatus(count === 1 ? "Saved 1 class." : `Saved ${count} classes.`);
      if (input) input.value = "";
      await loadDashboard();
    } catch (err) {
      const aborted = err && (err.name === "AbortError" || /aborted/i.test(String(err.message || "")));
      setScheduleStatus(aborted ? "Upload timed out. Try again." : err.message || "Could not read that PDF.");
    }
  }

  document.getElementById("schedule-pick")?.addEventListener("click", () => {
    const input = document.getElementById("schedulePdf");
    if (!input) return;
    if (!signedInViaGoogle()) {
      setScheduleStatus(NEED_GOOGLE);
      return;
    }
    input.value = "";
    input.click();
  });
  document.getElementById("schedulePdf")?.addEventListener("change", () => {
    if (document.getElementById("schedulePdf")?.files?.[0]) uploadSchedulePdf();
  });
  document.getElementById("settings-open").addEventListener("click", () => {
    spinSettingsGear();
    openSheet();
  });
  document.getElementById("settings-close").addEventListener("click", () => {
    closeSheet();
  });
  document.getElementById("stage-google")?.addEventListener("click", () => {
    startGoogleRedirect();
  });
  document.getElementById("google-redirect")?.addEventListener("click", () => {
    startGoogleRedirect();
  });
  document.getElementById("google-signout")?.addEventListener("click", () => {
    signOutGoogle();
  });
  const schoolInput = form.school;
  schoolInput.addEventListener("input", () => {
    const slugEl = document.getElementById("schoolSlug");
    if (slugEl) slugEl.value = "";
    paintNavSummaries();
    clearTimeout(schoolTimer);
    schoolTimer = setTimeout(() => searchSchools(schoolInput.value), 220);
  });
  schoolInput.addEventListener("focus", () => {
    searchSchools(schoolInput.value || DEFAULT_SCHOOL);
  });
  schoolInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      hideSchoolResults();
      return;
    }
    if (ev.key === "Enter") {
      const first = document.querySelector("#school-results li");
      const box = document.getElementById("school-results");
      if (first && box && !box.hidden) {
        ev.preventDefault();
        pickSchool(first);
      }
    }
  });
  document.getElementById("school-results")?.addEventListener("click", (ev) => {
    const li = ev.target.closest("li");
    if (li) pickSchool(li);
  });
  document.addEventListener("click", (ev) => {
    const wrap = ev.target.closest(".edu-school-search");
    if (!wrap) hideSchoolResults();
  });
  sheet.addEventListener("click", (ev) => {
    if (ev.target !== sheet) return;
    if (keysOpen()) closeKeys();
    else closeSheet();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !sheet.hidden) {
      const box = document.getElementById("school-results");
      if (box && !box.hidden) {
        hideSchoolResults();
        return;
      }
      if (keysOpen()) {
        closeKeys();
        return;
      }
      closeSheet();
    }
  });
  document.querySelectorAll(".set-nav[data-pane]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openPane(btn.getAttribute("data-pane"));
    });
  });
  document.querySelectorAll(".set-pane-close").forEach((btn) => {
    btn.addEventListener("click", () => {
      closePane();
    });
  });
  appEl.addEventListener("change", (ev) => {
    const input = ev.target.closest("input[data-filter]");
    if (!input) return;
    const tag = input.getAttribute("data-filter");
    if (!tag) return;
    if (input.checked) typeFilter.add(tag);
    else typeFilter.delete(tag);
    if (typeFilter.size === 0) TAGS.forEach((t) => typeFilter.add(t));
    paintAssignmentFilters();
  });
  appEl.addEventListener("click", (ev) => {
    const check = ev.target.closest(".edu-check");
    if (!check || check.classList.contains("is-checked")) return;
    ev.preventDefault();
    completeTodoRow(check);
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (activePane() === "chat" || document.getElementById("modelKey")?.value.trim()) {
      await saveChatKey();
      return;
    }
    if (!signedInViaGoogle()) {
      setStatus(statusEl, NEED_GOOGLE);
      return;
    }
    const studentId = form.studentId.value.trim();
    setStatus(statusEl, "Saving…");
    const payload = {
      school: form.school.value.trim() || DEFAULT_SCHOOL,
      studentId,
      canvasHost: form.canvasHost.value.trim(),
    };
    const slugEl = document.getElementById("schoolSlug");
    if (slugEl && slugEl.value.trim()) payload.schoolSlug = slugEl.value.trim();
    const canvasToken = form.canvasToken.value.trim();
    if (canvasToken) payload.canvasToken = canvasToken;
    try {
      me = await api("/v1/me", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      form.canvasToken.value = "";
      const canvasEntry = document.getElementById("canvas-entry");
      if (canvasEntry) delete canvasEntry.dataset.replace;
      paintAccount();
      paintCanvasToken();
      paintOnedrive();
      paintOutlook();
      applyAgentFromMe();
      await loadDashboard();
    } catch (err) {
      if (err.status === 401) {
        setStatus(statusEl, NEED_GOOGLE);
        return;
      }
      setStatus(statusEl, err.message || "Could not save.");
    }
  });

  function stopOdPoll() {
    clearInterval(odPollTimer);
    odPollTimer = 0;
  }

  function stopOlPoll() {
    clearInterval(olPollTimer);
    olPollTimer = 0;
  }

  async function tickOnedrive() {
    if (odPollInFlight) return;
    odPollInFlight = true;
    try {
      const st = await api("/v1/me/onedrive/status", { timeoutMs: 15000 });
      lastOdError = st.error || "";
      if (st.connected) {
        stopOdPoll();
        me = Object.assign({}, me, {
          onedriveConnected: true,
          onedriveEmail: st.email || "",
          onedrivePending: null,
        });
        if (st.outlookConnected) {
          stopOlPoll();
          me = Object.assign({}, me, {
            outlookConnected: true,
            outlookEmail: st.outlookEmail || "",
            outlookPending: null,
          });
          paintOutlook();
        }
        paintOnedrive();
        await loadDashboard();
        return;
      }
      if (st.pending && (st.pending.user_code || st.pending.verification_uri)) {
        me = Object.assign({}, me, { onedrivePending: st.pending });
        paintOnedrive();
        if (st.error) setStatus(odStatus, st.error);
        return;
      }
      stopOdPoll();
      me = Object.assign({}, me, { onedrivePending: null });
      paintOnedrive();
      if (st.error) setStatus(odStatus, st.error);
    } catch {
      /* keep polling */
    } finally {
      odPollInFlight = false;
    }
  }

  async function tickOutlook() {
    if (olPollInFlight) return;
    olPollInFlight = true;
    try {
      const st = await api("/v1/me/outlook/status", { timeoutMs: 15000 });
      lastOlError = st.error || "";
      if (st.connected) {
        stopOlPoll();
        me = Object.assign({}, me, {
          outlookConnected: true,
          outlookEmail: st.email || "",
          outlookPending: null,
        });
        if (st.onedriveConnected) {
          stopOdPoll();
          me = Object.assign({}, me, {
            onedriveConnected: true,
            onedriveEmail: st.onedriveEmail || "",
            onedrivePending: null,
          });
          paintOnedrive();
        }
        paintOutlook();
        await loadDashboard();
        return;
      }
      if (st.pending && (st.pending.user_code || st.pending.verification_uri)) {
        me = Object.assign({}, me, { outlookPending: st.pending });
        paintOutlook();
        if (st.error) setStatus(olStatus, st.error);
        return;
      }
      stopOlPoll();
      me = Object.assign({}, me, { outlookPending: null });
      paintOutlook();
      if (st.error) setStatus(olStatus, st.error);
    } catch {
      /* keep polling */
    } finally {
      olPollInFlight = false;
    }
  }

  function watchOnedrive() {
    stopOdPoll();
    tickOnedrive();
    odPollTimer = setInterval(tickOnedrive, 4000);
  }

  function watchOutlook() {
    stopOlPoll();
    tickOutlook();
    olPollTimer = setInterval(tickOutlook, 4000);
  }

  function linkNameFromUrl(url) {
    try {
      const u = new URL(url);
      const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
      return last || u.hostname;
    } catch {
      return "OneDrive link";
    }
  }

  function addLocalLink(url) {
    const href = String(url || "").trim();
    if (!/^https:\/\//i.test(href)) throw new Error("Paste a https link from OneDrive.");
    const rec = {
      id: `local:${Date.now()}`,
      name: linkNameFromUrl(href),
      webUrl: href,
      source: "link",
    };
    writeJson(LS_LINKS, [rec, ...readJson(LS_LINKS, [])].slice(0, 40));
    return rec;
  }

  async function saveLocalUpload(file) {
    const rec = {
      id: `local:${Date.now()}-${file.name}`,
      name: file.name || "upload",
      webUrl: "",
      source: "upload",
      dataUrl: "",
    };
    if (file.size <= 1_500_000) {
      rec.dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Could not read that file."));
        reader.readAsDataURL(file);
      });
      rec.webUrl = rec.dataUrl;
    }
    writeJson(LS_FILES, [rec, ...readJson(LS_FILES, [])].slice(0, 40));
    return rec;
  }

  document.getElementById("onedrive-upload-btn")?.addEventListener("click", () => {
    document.getElementById("onedrive-upload")?.click();
  });

  document.getElementById("onedrive-link-add")?.addEventListener("click", () => {
    const input = document.getElementById("onedrive-link");
    try {
      addLocalLink(input && input.value);
      if (input) input.value = "";
      lastOdError = "";
      paintOnedrive();
      loadDashboard();
    } catch (err) {
      lastOdError = err.message || "Could not add that link.";
      paintOnedrive();
    }
  });

  document.getElementById("outlook-ics-btn")?.addEventListener("click", () => {
    document.getElementById("outlook-ics")?.click();
  });

  document.getElementById("outlook-ics")?.addEventListener("change", async () => {
    const input = document.getElementById("outlook-ics");
    const file = input && input.files && input.files[0];
    if (!file) return;
    try {
      const events = parseIcs(await file.text());
      if (!events.length) throw new Error("No events in that calendar file.");
      writeJson(LS_EVENTS, events.slice(0, 80));
      lastOlError = "";
      if (input) input.value = "";
      paintOutlook();
      await loadDashboard();
    } catch (err) {
      lastOlError = err.message || "Could not read that calendar.";
      paintOutlook();
    }
  });

  document.getElementById("outlook-save-msg")?.addEventListener("click", () => {
    const from = String(document.getElementById("outlook-save-from")?.value || "").trim();
    const subject = String(document.getElementById("outlook-save-subject")?.value || "").trim();
    const body = String(document.getElementById("outlook-save-body")?.value || "").trim();
    if (!subject && !body) {
      lastOlError = "Add a subject or message first.";
      paintOutlook();
      return;
    }
    const rec = {
      id: `local:${Date.now()}`,
      subject: subject || "(no subject)",
      from,
      fromAddress: from,
      preview: body.slice(0, 400),
      body,
      received: new Date().toISOString(),
      unread: true,
      webLink: "",
    };
    writeJson(LS_MAIL, [rec, ...readJson(LS_MAIL, [])].slice(0, 40));
    const fromEl = document.getElementById("outlook-save-from");
    const subEl = document.getElementById("outlook-save-subject");
    const bodyEl = document.getElementById("outlook-save-body");
    if (fromEl) fromEl.value = "";
    if (subEl) subEl.value = "";
    if (bodyEl) bodyEl.value = "";
    lastOlError = "";
    paintOutlook();
    loadDashboard();
  });

  async function readUploadPayload(file) {
    const name = file.name || "upload";
    const contentType = file.type || "application/octet-stream";
    const textLike =
      /^text\/|^application\/(json|xml|javascript|x-javascript)/i.test(contentType) ||
      /\.(txt|md|csv|json|html|css|js|xml)$/i.test(name);
    if (textLike && file.size <= 1_500_000) {
      return { name, content: await file.text(), contentType };
    }
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { name, content: btoa(binary), contentType, encoding: "base64" };
  }

  async function uploadSchoolFile(file) {
    const payload = await readUploadPayload(file);
    return api("/v1/me/onedrive/file", {
      method: "PUT",
      body: JSON.stringify(payload),
      timeoutMs: 30000,
    });
  }

  document.getElementById("onedrive-upload")?.addEventListener("change", async () => {
    const input = document.getElementById("onedrive-upload");
    const file = input && input.files && input.files[0];
    if (!file) return;
    const status = document.getElementById("onedrive-upload-status");
    if (!signedInViaGoogle()) {
      if (status) status.textContent = NEED_GOOGLE;
      return;
    }
    if (status) status.textContent = `Saving ${file.name}…`;
    try {
      await saveLocalUpload(file);
      try {
        await uploadSchoolFile(file);
      } catch {
        /* API vault is optional until the Mac API restarts */
      }
      input.value = "";
      if (status) status.textContent = "";
      lastOdError = "";
      paintOnedrive();
      await loadDashboard();
    } catch (err) {
      if (status) status.textContent = err.message || "Upload failed.";
    }
  });

  appEl.addEventListener("click", (ev) => {
    const t = ev.target;
    const todosToggle = t.closest?.("[data-todos-expand]");
    if (todosToggle) {
      ev.preventDefault();
      todoExpanded = !todoExpanded;
      routeAndRender();
    }
    const uploadBtn = t.closest?.("[data-file-upload]");
    if (uploadBtn) {
      ev.preventDefault();
      document.getElementById("onedrive-upload")?.click();
    }
  });

  appEl.addEventListener("click", async (ev) => {
    const a = ev.target.closest("[data-vault-id]");
    if (!a) return;
    ev.preventDefault();
    const id = a.getAttribute("data-vault-id");
    if (!id) return;
    try {
      const headers = { Accept: "*/*" };
      const session = sid();
      if (session) headers["X-EPSynapse-Session"] = session;
      const res = await fetch(`${apiBase}/v1/me/onedrive/file?id=${encodeURIComponent(id)}`, {
        credentials: "include",
        headers,
      });
      if (!res.ok) throw new Error("Download failed.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const go = document.createElement("a");
      go.href = url;
      go.target = "_blank";
      go.rel = "noopener";
      go.download = String(id).replace(/^vault:/, "") || "file";
      document.body.appendChild(go);
      go.click();
      go.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      const status = document.getElementById("onedrive-upload-status");
      if (status) status.textContent = err.message || "Download failed.";
    }
  });

  appEl.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-mail-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-mail-id");
    if (!id) return;
    if (String(id).startsWith("local:")) {
      openMail = (lastHome.messages || []).find((m) => m.id === id) || null;
      routeAndRender();
      return;
    }
    try {
      const data = await api(`/v1/me/outlook/message?id=${encodeURIComponent(id)}`, { timeoutMs: 20000 });
      openMail = data.message || null;
      routeAndRender();
    } catch (err) {
      openMail = { subject: "Could not open", body: err.message || "Read failed." };
      routeAndRender();
    }
  });

  appEl.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-route]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("http")) return;
    ev.preventDefault();
    goTo(href);
  });

  appEl.addEventListener("submit", async (ev) => {
    const noteForm = ev.target.closest("#notes-classify");
    if (noteForm) {
      ev.preventDefault();
      const status = document.getElementById("note-status");
      const text = String(noteForm.text?.value || "").trim();
      if (!text) {
        if (status) status.textContent = "Paste some notes first.";
        return;
      }
      if (status) status.textContent = "Classifying…";
      try {
        const created = await api("/v1/me/notes", {
          method: "POST",
          body: JSON.stringify({ text }),
          timeoutMs: 180000,
        });
        const note = created.note || created;
        if (note?.id) {
          const others = (lastHome.notes || []).filter((n) => n.id !== note.id);
          lastHome.notes = [note, ...others];
          goTo(`/note/${encodeURIComponent(note.id)}`);
          return;
        }
        if (status) status.textContent = "Classified, but no note id came back.";
      } catch (err) {
        if (status) status.textContent = err.message || "Classify failed.";
      }
      return;
    }

    const goldForm = ev.target.closest("#note-gold");
    if (goldForm) {
      ev.preventDefault();
      const route = currentRoute();
      const status = document.getElementById("note-gold-status");
      const subject = String(goldForm.subject?.value || "").trim();
      if (!route.id || !subject) return;
      if (status) status.textContent = "Saving…";
      try {
        const updated = await api(`/v1/me/notes/${encodeURIComponent(route.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ subject }),
        });
        const note = updated.note || updated;
        lastHome.notes = (lastHome.notes || []).map((n) => (n.id === note.id ? note : n));
        renderNote(route.id);
        const again = document.getElementById("note-gold-status");
        if (again) again.textContent = "Saved.";
      } catch (err) {
        if (status) status.textContent = err.message || "Could not save subject.";
      }
      return;
    }

    const compose = ev.target.closest("#outlook-compose");
    if (!compose) return;
    ev.preventDefault();
    if (mailBusy) return;
    const to = compose.to.value.trim();
    const subject = compose.subject.value.trim();
    const body = compose.body.value.trim();
    const status = document.getElementById("outlook-send-status");
    if (!to || !subject || !body) {
      if (status) status.textContent = "To, subject, and body are required.";
      return;
    }
    if (compose.dataset.mailMode === "mailto") {
      const addrs = to
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(",");
      window.location.href = `mailto:${addrs}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      if (status) status.textContent = "Opened your mail app.";
      return;
    }
    if (!window.confirm(`Send this email to ${to}?`)) return;
    mailBusy = true;
    routeAndRender();
    try {
      const sent = await api("/v1/me/outlook/send", {
        method: "POST",
        body: JSON.stringify({ to, subject, body }),
        timeoutMs: 25000,
      });
      mailBusy = false;
      openMail = null;
      routeAndRender();
      const again = document.getElementById("outlook-send-status");
      if (again) again.textContent = sent.sent ? `Sent to ${sent.to}` : "Sent.";
    } catch (err) {
      mailBusy = false;
      routeAndRender();
      const form = document.getElementById("outlook-compose");
      if (form) {
        form.to.value = to;
        form.subject.value = subject;
        form.body.value = body;
      }
      const again = document.getElementById("outlook-send-status");
      if (again) again.textContent = err.message || "Send failed.";
    }
  });

  document.getElementById("key-save").addEventListener("click", () => {
    saveChatKey();
  });

  document.getElementById("modelKey")?.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    saveChatKey();
  });

  document.getElementById("key-replace")?.addEventListener("click", () => {
    if (!signedInViaGoogle()) return;
    const entry = document.getElementById("key-entry");
    if (entry) entry.dataset.replace = "1";
    refreshKeyStatus();
    document.getElementById("modelKey")?.focus();
  });

  document.getElementById("canvas-replace")?.addEventListener("click", () => {
    if (!signedInViaGoogle()) return;
    const entry = document.getElementById("canvas-entry");
    if (entry) entry.dataset.replace = "1";
    paintCanvasToken();
    form.canvasToken?.focus();
  });

  document.getElementById("key-clear").addEventListener("click", async () => {
    if (!signedInViaGoogle()) {
      setStatus(keyStatus, NEED_GOOGLE);
      return;
    }
    setStatus(keyStatus, "Clearing…");
    try {
      me = await api("/v1/me/agent", {
        method: "POST",
        body: JSON.stringify({ clear: true }),
      });
      localStorage.removeItem(LS_KEY);
      document.getElementById("modelKey").value = "";
      const entry = document.getElementById("key-entry");
      if (entry) delete entry.dataset.replace;
      applyAgentFromMe();
    } catch (err) {
      setStatus(keyStatus, err.message || "Could not clear the key.");
    }
  });

  providerSel.addEventListener("change", async () => {
    if (!signedInViaGoogle()) return;
    const provider = providerSel.value || "groq";
    localStorage.setItem(LS_PROV, provider);
    document.documentElement.dataset.modelProvider = provider;
    refreshKeyStatus();
    try {
      me = await api("/v1/me/agent", {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      applyAgentFromMe();
    } catch {
      /* picker still works locally until they save again */
    }
  });

  boot();
})();
