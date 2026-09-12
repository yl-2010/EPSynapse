(() => {
  const LS_SID = "epsynapse.sid";
  const LS_KEY = "epsynapse.agent.key";
  const LS_PROV = "epsynapse.agent.provider";

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
  const typeFilter = new Set(TAGS);
  let lastHome = {
    courses: [],
    assignments: [],
    files: [],
    messages: [],
    classes: [],
    meetings: [],
    notes: [],
  };
  let openMail = null;
  let mailBusy = false;
  let googleClientId = "";
  let gisConfigError = "";
  let gisInitialized = false;
  let schoolTimer = 0;
  const DEFAULT_SCHOOL = "Eastside Prep";
  const NEED_GOOGLE = "Sign in with Google first.";

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
    document.documentElement.dataset.auth = on ? "in" : "out";
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
      if (me?.onedrivePending && !me.onedriveConnected) watchOnedrive();
      if (me?.outlookPending && !me.outlookConnected) watchOutlook();
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
    refreshKeyStatus();
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
    const od = document.getElementById("onedrive-summary");
    if (od) {
      od.textContent =
        me && me.onedriveConnected ? me.onedriveEmail || "Connected" : "School files";
    }
    const ol = document.getElementById("outlook-summary");
    if (ol) {
      ol.textContent =
        me && me.outlookConnected ? me.outlookEmail || "Connected" : "School mail";
    }
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

  function openSheet() {
    if (!signedInViaGoogle()) return;
    closePane(true);
    sheet.hidden = false;
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
  }

  function closeSheet() {
    hideSchoolResults();
    closePane(true);
    sheet.hidden = true;
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

  function panelHtml(title, body, filterId, extraClass, filtersHtml) {
    return `<section class="edu-panel${extraClass ? " " + extraClass : ""}" data-filter-id="${escapeHtml(filterId)}">
      <div class="edu-panel-head"><h2 class="edu-panel-title">${escapeHtml(title)}</h2>${filtersHtml || ""}</div>
      ${body}
    </section>`;
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
    return `<ul class="edu-list">${itemsHtml}</ul>`;
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
    return `<li class="edu-row edu-todo${t.done ? " is-done" : ""}">
      <span class="edu-check${t.done ? " is-checked" : ""}" data-liquid-glass="circle" data-filter-id="lg-check-${escapeHtml(t.id)}" aria-hidden="true"><span class="edu-check-dot"></span></span>
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
    const period = c.period
      ? `<span class="edu-tag edu-period">${escapeHtml(c.period)}</span>`
      : "";
    const highlight = isCurrentClass(c);
    const href = classHref(c);
    const meta = c.courseCode || (c.term ? c.term : "");
    return `<li class="edu-row edu-class-row${highlight ? " is-current" : ""}">
      <a class="edu-row-link" data-route href="${escapeHtml(href)}">
        <span class="edu-name">${period}<span class="edu-hero-class-name">${escapeHtml(c.name)}</span></span>
        <span class="edu-meta">${escapeHtml(meta)}</span>
      </a>
    </li>`;
  }

  function dateRow(t) {
    const tag = t.tag || "HW";
    return `<li class="edu-row${tag === "MA" ? " is-ma" : ""}">
      <span class="edu-name"><span class="edu-tag edu-tag-${escapeHtml(tag)}">${escapeHtml(tag)}</span> ${escapeHtml(t.title)}</span>
      <span class="edu-meta">${escapeHtml(formatDue(t.due))}</span>
    </li>`;
  }

  function fileTile(f, i) {
    const href = f.webUrl || `${apiBase}/v1/me/onedrive/file?id=${encodeURIComponent(f.id)}`;
    return `<a class="edu-file-tile" href="${escapeHtml(href)}" target="_blank" rel="noopener" data-filter-id="lg-file-${i}" title="${escapeHtml(f.name)}"><span class="edu-file-name">${escapeHtml(f.name)}</span></a>`;
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
    return `<li class="edu-row${unread}">
      <button type="button" class="edu-row-link" data-mail-id="${escapeHtml(m.id)}" style="all:unset;cursor:pointer;display:block;width:100%">
        <span class="edu-name">${escapeHtml(m.subject || "(no subject)")}</span>
        <span class="edu-meta">${escapeHtml(who)} · ${escapeHtml(formatMailWhen(m.received))}</span>
      </button>
    </li>`;
  }

  function mailPanelHtml(messages) {
    if (!me?.outlookConnected) {
      return `<p class="edu-empty">Connect Outlook in settings</p>`;
    }
    const rows = (messages || []).map(mailRow).join("");
    const list = rows ? `<ul class="edu-list">${rows}</ul>` : `<p class="edu-empty">Inbox is empty</p>`;
    const open = openMail
      ? `<div class="edu-mail-open">
          <p class="edu-name">${escapeHtml(openMail.subject || "")}</p>
          <p class="edu-meta">${escapeHtml(openMail.from || "")}</p>
          <pre class="edu-mail-body">${escapeHtml(openMail.body || openMail.preview || "")}</pre>
        </div>`
      : "";
    const sendLabel = mailBusy ? "Sending…" : "Send";
    return `${list}${open}
      <form class="edu-compose" id="outlook-compose">
        <input id="outlook-to" name="to" type="text" placeholder="To (comma-separated)" required />
        <input id="outlook-subject" name="subject" placeholder="Subject" required maxlength="200" />
        <textarea id="outlook-body" name="body" placeholder="Message" required maxlength="8000"></textarea>
        <button type="submit" class="edu-sheet-btn edu-sheet-btn--gold" data-liquid-glass="rounded" data-filter-id="lg-edu-ol-send"${mailBusy ? " disabled" : ""}>${sendLabel}</button>
        <p class="edu-empty" id="outlook-send-status"></p>
      </form>`;
  }

  function homeClasses() {
    const scheduled = (lastHome.classes || []).filter((c) => !c.freePeriod);
    if (scheduled.length) return scheduled;
    return lastHome.courses || [];
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
      : `<p class="edu-empty">Paste a note and classify it</p>`;
    return `${list}
      <form class="edu-notes-form" id="notes-classify">
        <textarea id="note-text" name="text" maxlength="12000" placeholder="Paste class notes" required></textarea>
        <button type="submit" class="edu-sheet-btn edu-sheet-btn--gold" data-liquid-glass="rounded" data-filter-id="lg-edu-note-go">Classify</button>
        <p class="edu-empty" id="note-status"></p>
      </form>`;
  }

  function renderHome({ courses, assignments, files, messages, classes, meetings, notes } = lastHome) {
    lastHome = {
      courses: courses || lastHome.courses || [],
      assignments: assignments || lastHome.assignments || [],
      files: files || lastHome.files || [],
      messages: messages || lastHome.messages || [],
      classes: classes || lastHome.classes || [],
      meetings: meetings || lastHome.meetings || [],
      notes: notes || lastHome.notes || [],
    };
    const open = (lastHome.assignments || []).filter((t) => !t.done && matchesTag(t));
    const done = (lastHome.assignments || []).filter((t) => t.done && matchesTag(t));
    const dates = (lastHome.assignments || [])
      .filter((t) => t.due && matchesTag(t))
      .sort((a, b) => String(a.due).localeCompare(String(b.due)))
      .slice(0, 12);
    const fileTiles = (lastHome.files || []).map(fileTile).join("");
    const classItems = homeClasses();

    const todoEmpty = me?.canvasConnected
      ? "No open work"
      : "Connect Canvas in settings";
    const classEmpty = classItems.length
      ? "No classes"
      : "Upload a term schedule PDF in settings";
    const fileEmpty = me?.onedriveConnected
      ? "No files in /EPSynapse yet"
      : "Connect OneDrive in settings";

    appEl.classList.add("is-settled");
    appEl.innerHTML = `
      <p class="edu-home-mark">EPSynapse <a class="edu-home-research" href="/research">Research</a></p>
      <div class="edu-grid edu-grid--home">
        <div class="edu-col edu-col--main">
          ${panelHtml("TODO", listOrEmpty(open.map(todoRow).join(""), todoEmpty), "lg-edu-todo", "", filterBarHtml("todo"))}
          ${panelHtml("Completed", listOrEmpty(done.map(todoRow).join(""), "Nothing completed yet"), "lg-edu-completed", "edu-panel--completed")}
          ${panelHtml("Notes", notesPanelHtml(), "lg-edu-notes", "edu-panel--notes")}
        </div>
        <div class="edu-col edu-col--side">
          ${panelHtml("Classes", listOrEmpty(classItems.map(classRow).join(""), classEmpty), "lg-edu-classes")}
          ${panelHtml("Dates", listOrEmpty(dates.map(dateRow).join(""), "No upcoming dates"), "lg-edu-dates", "", filterBarHtml("dates"))}
          ${panelHtml("Files", fileTiles ? `<div class="edu-files">${fileTiles}</div>` : `<p class="edu-empty">${escapeHtml(fileEmpty)}</p>`, "lg-edu-files")}
          ${panelHtml("Mail", mailPanelHtml(lastHome.messages), "lg-edu-mail")}
        </div>
      </div>
    `;
    if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
  }

  function classMatchesWork(klass, item) {
    if (!klass || !item) return false;
    const courseId = String(klass.canvasCourseId || klass.courseId || "");
    if (courseId && String(item.courseId || "") === courseId) return true;
    const a = String(klass.name || "").toLowerCase();
    const b = String(item.courseName || "").toLowerCase();
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
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
    const open = work.filter((t) => !t.done && matchesTag(t));
    const done = work.filter((t) => t.done && matchesTag(t));
    const dates = work
      .filter((t) => t.due && matchesTag(t))
      .sort((a, b) => String(a.due).localeCompare(String(b.due)))
      .slice(0, 12);
    const nameHint = String(klass.name || "").toLowerCase();
    const files = (lastHome.files || []).filter((f) => {
      if (!nameHint) return false;
      return String(f.name || "").toLowerCase().includes(nameHint);
    });
    const fileTiles = (files.length ? files : lastHome.files || []).map(fileTile).join("");
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

    const period = klass.period
      ? `<span class="edu-tag edu-period edu-period--hero">${escapeHtml(klass.period)}</span>`
      : "";
    const next = nextMeetingLine(klass);
    const sub = [klass.term, klass.subject, klass.courseCode, next].filter(Boolean).join(" · ");
    appEl.classList.add("is-settled");
    appEl.innerHTML = `
      <p class="edu-home-mark"><a class="edu-home-research" data-route href="/">Home</a></p>
      <header class="edu-hero edu-hero--detail edu-hero--detail-canvas">
        <div class="edu-hero-lead">
          <h1 class="edu-hero-title edu-hero-title--class">${period}<span class="edu-hero-class-name">${escapeHtml(klass.name)}</span></h1>
          <p class="edu-hero-sub">${escapeHtml(sub)}</p>
        </div>
      </header>
      <div class="edu-grid edu-grid--home">
        <div class="edu-col edu-col--main">
          ${panelHtml("TODO", listOrEmpty(open.map(todoRow).join(""), "No open work for this class"), "lg-edu-todo", "", filterBarHtml("todo"))}
          ${panelHtml("Completed", listOrEmpty(done.map(todoRow).join(""), "Nothing completed yet"), "lg-edu-completed", "edu-panel--completed")}
        </div>
        <div class="edu-col edu-col--side">
          ${panelHtml("Dates", listOrEmpty(dates.map(dateRow).join(""), "No upcoming dates"), "lg-edu-dates", "", filterBarHtml("dates"))}
          ${panelHtml("Files", fileTiles ? `<div class="edu-files">${fileTiles}</div>` : `<p class="edu-empty">No files for this class</p>`, "lg-edu-files")}
          ${panelHtml("Notes", listOrEmpty(noteRows, "No notes for this class yet"), "lg-edu-class-notes")}
        </div>
      </div>
    `;
    if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
  }

  function voteLine(label, vote) {
    if (!vote || !vote.subject) return `<li class="edu-row"><span class="edu-name">${escapeHtml(label)}</span><span class="edu-meta">no vote</span></li>`;
    const conf =
      typeof vote.confidence === "number" ? ` · ${Math.round(vote.confidence * 100)}%` : "";
    return `<li class="edu-row"><span class="edu-name">${escapeHtml(label)}</span><span class="edu-meta">${escapeHtml(vote.subject)}${escapeHtml(conf)}</span></li>`;
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
    const votes = note.votes || {};
    const orch = note.orchestrator || {};
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
            "Votes",
            `<ul class="edu-list">
              ${voteLine("Zero-shot BERT", votes.baseBert)}
              ${voteLine("Fine-tuned BERT", votes.fineTunedBert)}
              ${voteLine("Student-key model", votes.studentKey)}
              ${voteLine("Orchestrator", { subject: orch.subject || note.subject, confidence: orch.confidence })}
            </ul>`,
            "lg-edu-note-votes"
          )}
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
    const assignments = me?.canvasConnected
      ? api("/v1/me/canvas/assignments").then((r) => r.assignments || []).catch(() => [])
      : Promise.resolve([]);
    const files = me?.onedriveConnected
      ? api("/v1/me/onedrive/files", { timeoutMs: 20000 }).then((r) => r.files || []).catch(() => [])
      : Promise.resolve([]);
    const messages = me?.outlookConnected
      ? api("/v1/me/outlook/messages?limit=12", { timeoutMs: 20000 }).then((r) => r.messages || []).catch(() => [])
      : Promise.resolve([]);
    const schedule = api("/v1/me/schedule")
      .then((r) => r)
      .catch(() => ({ classes: [], meetings: [] }));
    const notes = api("/v1/me/notes")
      .then((r) => r.notes || [])
      .catch(() => []);
    const sched = await schedule;
    lastHome = {
      courses: await courses,
      assignments: await assignments,
      files: await files,
      messages: await messages,
      classes: sched.classes || [],
      meetings: sched.meetings || [],
      notes: await notes,
    };
    routeAndRender();
  }

  function showOnedriveCode(code, uri) {
    const codeEl = document.getElementById("onedrive-code");
    const openEl = document.getElementById("onedrive-open");
    if (!codeEl || !openEl) return;
    if (code) {
      codeEl.hidden = false;
      codeEl.textContent = code;
    } else {
      codeEl.hidden = true;
      codeEl.textContent = "";
    }
    if (uri) {
      openEl.hidden = false;
      openEl.href = uri;
    } else {
      openEl.hidden = true;
    }
  }

  function paintOnedrive() {
    if (!signedInViaGoogle()) {
      setStatus(odStatus, NEED_GOOGLE);
      showOnedriveCode("", "");
      paintNavSummaries();
      return;
    }
    if (!me) {
      setStatus(odStatus, "OneDrive");
      showOnedriveCode("", "");
      paintNavSummaries();
      return;
    }
    const odBtn = document.getElementById("onedrive-start");
    if (odBtn) odBtn.hidden = Boolean(me.onedriveConnected);
    if (me.onedriveConnected) {
      setStatus(odStatus, me.onedriveEmail ? `OneDrive · ${me.onedriveEmail}` : "OneDrive connected");
      showOnedriveCode("", "");
      paintNavSummaries();
      return;
    }
    const p = me.onedrivePending;
    if (p && (p.user_code || p.verification_uri)) {
      setStatus(odStatus, "Enter this code on the Microsoft page, then come back here.");
      showOnedriveCode(p.user_code, p.verification_uri || "https://login.microsoft.com/device");
      paintNavSummaries();
      return;
    }
    setStatus(odStatus, "OneDrive");
    showOnedriveCode("", "");
    paintNavSummaries();
  }

  function showOutlookCode(code, uri) {
    const codeEl = document.getElementById("outlook-code");
    const openEl = document.getElementById("outlook-open");
    if (!codeEl || !openEl) return;
    if (code) {
      codeEl.hidden = false;
      codeEl.textContent = code;
    } else {
      codeEl.hidden = true;
      codeEl.textContent = "";
    }
    if (uri) {
      openEl.hidden = false;
      openEl.href = uri;
    } else {
      openEl.hidden = true;
    }
  }

  function paintOutlook() {
    if (!signedInViaGoogle()) {
      setStatus(olStatus, NEED_GOOGLE);
      showOutlookCode("", "");
      paintNavSummaries();
      return;
    }
    if (!me) {
      setStatus(olStatus, "Outlook");
      showOutlookCode("", "");
      paintNavSummaries();
      return;
    }
    const olBtn = document.getElementById("outlook-start");
    if (olBtn) olBtn.hidden = Boolean(me.outlookConnected);
    if (me.outlookConnected) {
      setStatus(olStatus, me.outlookEmail ? `Outlook · ${me.outlookEmail}` : "Outlook connected");
      showOutlookCode("", "");
      paintNavSummaries();
      return;
    }
    const p = me.outlookPending;
    if (p && (p.user_code || p.verification_uri)) {
      setStatus(olStatus, "Enter this code on the Microsoft page, then come back here.");
      showOutlookCode(p.user_code, p.verification_uri || "https://login.microsoft.com/device");
      paintNavSummaries();
      return;
    }
    setStatus(olStatus, "Outlook");
    showOutlookCode("", "");
    paintNavSummaries();
  }

  function paintCanvasToken() {
    const entry = document.getElementById("canvas-entry");
    const ready = document.getElementById("canvas-ready");
    const connected = Boolean(me && me.canvasConnected);
    const replacing = entry && entry.dataset.replace === "1";
    if (entry) entry.hidden = connected && !replacing;
    if (ready) ready.hidden = !connected;
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
    if (hasKey && !replacing) {
      setStatus(keyStatus, "");
      return;
    }
    if (hasKey && replacing) {
      setStatus(keyStatus, "Paste a new key to replace the one on this account.");
      return;
    }
    setStatus(keyStatus, signedInViaGoogle() ? "One key for the website and iPhone." : "");
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
    if (me?.onedrivePending && !me.onedriveConnected) watchOnedrive();
    if (me?.outlookPending && !me.outlookConnected) watchOutlook();
    await initGoogle();
  }

  window.addEventListener("popstate", () => {
    routeAndRender();
  });

  document.getElementById("home-open").addEventListener("click", goHome);

  document.getElementById("schedule-upload")?.addEventListener("click", async () => {
    const status = document.getElementById("schedule-status");
    if (!signedInViaGoogle()) {
      if (status) status.textContent = NEED_GOOGLE;
      return;
    }
    const input = document.getElementById("schedulePdf");
    const file = input && input.files && input.files[0];
    if (!file) {
      if (status) status.textContent = "Choose a term schedule PDF first.";
      return;
    }
    if (status) status.textContent = "Uploading…";
    const body = new FormData();
    body.append("pdf", file, file.name);
    try {
      const headers = { Accept: "application/json" };
      const session = sid();
      if (session) headers["X-EPSynapse-Session"] = session;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
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
      if (status) status.textContent = `Saved ${(payload.classes || []).filter((c) => !c.freePeriod).length} classes.`;
      if (input) input.value = "";
      await loadDashboard();
    } catch (err) {
      if (status) status.textContent = err.message || "Could not read that PDF.";
    }
  });
  document.getElementById("settings-open").addEventListener("click", openSheet);
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
    routeAndRender();
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
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
      if (st.connected) {
        stopOdPoll();
        me = Object.assign({}, me, {
          onedriveConnected: true,
          onedriveEmail: st.email || "",
          onedrivePending: null,
        });
        paintOnedrive();
        await loadDashboard();
        return;
      }
      if (st.pending && (st.pending.user_code || st.pending.verification_uri)) {
        me = Object.assign({}, me, { onedrivePending: st.pending });
        paintOnedrive();
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
      if (st.connected) {
        stopOlPoll();
        me = Object.assign({}, me, {
          outlookConnected: true,
          outlookEmail: st.email || "",
          outlookPending: null,
        });
        paintOutlook();
        await loadDashboard();
        return;
      }
      if (st.pending && (st.pending.user_code || st.pending.verification_uri)) {
        me = Object.assign({}, me, { outlookPending: st.pending });
        paintOutlook();
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

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (me?.onedrivePending && !me.onedriveConnected) tickOnedrive();
    if (me?.outlookPending && !me.outlookConnected) tickOutlook();
  });

  document.getElementById("onedrive-start").addEventListener("click", async () => {
    try {
      if (!signedInViaGoogle()) {
        setStatus(odStatus, NEED_GOOGLE);
        return;
      }
      const started = await api("/v1/me/onedrive/start", { method: "POST", body: "{}" });
      if (started.user_code) {
        me = Object.assign({}, me, {
          onedrivePending: {
            user_code: started.user_code,
            verification_uri: started.verification_uri,
            message: started.message,
          },
        });
        paintOnedrive();
        const openAt = started.verification_uri_complete || started.verification_uri;
        if (openAt) window.open(openAt, "_blank", "noopener");
        watchOnedrive();
      } else {
        setStatus(odStatus, started.message || "Microsoft would not start school sign-in.");
        showOnedriveCode("", "");
      }
    } catch (err) {
      setStatus(odStatus, err.message || "Could not start OneDrive.");
    }
  });

  document.getElementById("outlook-start").addEventListener("click", async () => {
    try {
      if (!signedInViaGoogle()) {
        setStatus(olStatus, NEED_GOOGLE);
        return;
      }
      const started = await api("/v1/me/outlook/start", { method: "POST", body: "{}", timeoutMs: 20000 });
      if (started.user_code) {
        me = Object.assign({}, me, {
          outlookPending: {
            user_code: started.user_code,
            verification_uri: started.verification_uri,
            message: started.message,
          },
        });
        paintOutlook();
        const openAt = started.verification_uri_complete || started.verification_uri;
        if (openAt) window.open(openAt, "_blank", "noopener");
        watchOutlook();
      } else {
        setStatus(olStatus, started.message || "Microsoft would not start Outlook sign-in.");
        showOutlookCode("", "");
      }
    } catch (err) {
      setStatus(olStatus, err.message || "Could not start Outlook.");
    }
  });

  appEl.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-mail-id]");
    if (!btn) return;
    const id = btn.getAttribute("data-mail-id");
    if (!id) return;
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

  document.getElementById("key-save").addEventListener("click", async () => {
    if (!signedInViaGoogle()) {
      setStatus(keyStatus, NEED_GOOGLE);
      return;
    }
    const key = document.getElementById("modelKey").value.trim();
    if (!key) {
      setStatus(keyStatus, "Paste a key first.");
      return;
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
    } catch (err) {
      setStatus(keyStatus, err.message || "Could not save the key.");
    }
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
