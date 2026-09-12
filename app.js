(() => {
  const LS_SID = "epsynapse.sid";
  const LS_KEY = "epsynapse.agent.key";
  const LS_PROV = "epsynapse.agent.provider";

  const loading = document.getElementById("stage-loading");
  const stage = document.getElementById("stage-full");
  const appEl = document.getElementById("edu-app");
  const sheet = document.getElementById("settings-sheet");
  const form = sheet.querySelector(".edu-sheet");
  const statusEl = document.getElementById("settings-status");
  const odStatus = document.getElementById("onedrive-status");
  const keyStatus = document.getElementById("key-status");
  const providerSel = document.getElementById("provider");

  let apiBase = "";
  let me = null;
  let pollTimer = 0;
  const TAGS = ["CW", "HW", "QA", "MA"];
  const typeFilter = new Set(TAGS);
  let lastHome = { courses: [], assignments: [], files: [] };

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
    const res = await fetch(apiBase + path, {
      credentials: "include",
      ...opts,
      headers,
    });
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

  function openSheet() {
    sheet.hidden = false;
    if (me) {
      form.school.value = me.school || "Eastside Prep";
      form.studentId.value = me.studentId || "";
      form.canvasHost.value = me.canvasHost || "https://eastsideprep.instructure.com";
    }
    refreshKeyStatus();
    paintOnedrive();
    queueMicrotask(() => window.reinitLiquidGlass?.());
  }

  function closeSheet() {
    sheet.hidden = true;
  }

  function panelHtml(title, body, filterId, extraClass, filtersHtml) {
    return `<section class="edu-panel${extraClass ? " " + extraClass : ""}" data-liquid-glass="rounded" data-filter-id="${escapeHtml(filterId)}">
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

  function classRow(c) {
    const period = c.period
      ? `<span class="edu-tag edu-period">${escapeHtml(c.period)}</span>`
      : "";
    const cur = currentPeriod();
    const p = String(c.period || "").toUpperCase();
    const highlight = Boolean(cur && p && (p === cur[2] || p === cur[3]));
    return `<li class="edu-row edu-class-row${highlight ? " is-current" : ""}">
      <span class="edu-name">${period}<span class="edu-hero-class-name">${escapeHtml(c.name)}</span></span>
      <span class="edu-meta">${escapeHtml(c.courseCode || "")}</span>
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
    return `<a class="edu-file-tile" href="${escapeHtml(href)}" target="_blank" rel="noopener" data-liquid-glass="rounded" data-filter-id="lg-file-${i}" title="${escapeHtml(f.name)}"><span class="edu-file-name">${escapeHtml(f.name)}</span></a>`;
  }

  function renderHome({ courses, assignments, files }) {
    lastHome = { courses, assignments, files };
    const open = (assignments || []).filter((t) => !t.done && matchesTag(t));
    const done = (assignments || []).filter((t) => t.done && matchesTag(t));
    const dates = (assignments || [])
      .filter((t) => t.due && matchesTag(t))
      .sort((a, b) => String(a.due).localeCompare(String(b.due)))
      .slice(0, 12);
    const fileTiles = (files || []).map(fileTile).join("");

    const todoEmpty = me?.canvasConnected
      ? "No open work"
      : "Connect Canvas in settings";
    const classEmpty = me?.canvasConnected ? "No classes" : "Connect Canvas in settings";
    const fileEmpty = me?.onedriveConnected
      ? "No files in /EPSynapse yet"
      : "Connect OneDrive in settings";

    const school = me?.school || "Eastside Prep";
    appEl.classList.add("is-settled");
    appEl.innerHTML = `
      <p class="edu-home-mark">${escapeHtml(school)}</p>
      <div class="edu-grid edu-grid--home">
        <div class="edu-col edu-col--main">
          ${panelHtml("TODO", listOrEmpty(open.map(todoRow).join(""), todoEmpty), "lg-edu-todo", "", filterBarHtml("todo"))}
          ${panelHtml("Completed", listOrEmpty(done.map(todoRow).join(""), "Nothing completed yet"), "lg-edu-completed", "edu-panel--completed")}
        </div>
        <div class="edu-col edu-col--side">
          ${panelHtml("Classes", listOrEmpty((courses || []).map(classRow).join(""), classEmpty), "lg-edu-classes")}
          ${panelHtml("Dates", listOrEmpty(dates.map(dateRow).join(""), "No upcoming dates"), "lg-edu-dates", "", filterBarHtml("dates"))}
          ${panelHtml("Files", fileTiles ? `<div class="edu-files">${fileTiles}</div>` : `<p class="edu-empty">${escapeHtml(fileEmpty)}</p>`, "lg-edu-files")}
        </div>
      </div>
    `;
    if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
  }

  async function loadDashboard() {
    loading.hidden = true;
    stage.hidden = false;
    const courses = me?.canvasConnected
      ? api("/v1/me/canvas/courses").then((r) => r.courses || []).catch(() => [])
      : Promise.resolve([]);
    const assignments = me?.canvasConnected
      ? api("/v1/me/canvas/assignments").then((r) => r.assignments || []).catch(() => [])
      : Promise.resolve([]);
    const files = me?.onedriveConnected
      ? api("/v1/me/onedrive/files").then((r) => r.files || []).catch(() => [])
      : Promise.resolve([]);
    renderHome({
      courses: await courses,
      assignments: await assignments,
      files: await files,
    });
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
    if (!me) {
      setStatus(odStatus, "School OneDrive. Tap Connect, then sign in with @eastsideprep.org.");
      showOnedriveCode("", "");
      return;
    }
    if (me.onedriveConnected) {
      setStatus(odStatus, me.onedriveEmail ? `OneDrive · ${me.onedriveEmail}` : "OneDrive connected");
      showOnedriveCode("", "");
      return;
    }
    const p = me.onedrivePending;
    if (p && (p.user_code || p.verification_uri)) {
      setStatus(
        odStatus,
        "Enter this code on the Microsoft page, then sign in with your school email. Allow files access."
      );
      showOnedriveCode(p.user_code, p.verification_uri || "https://login.microsoft.com/device");
      return;
    }
    setStatus(odStatus, "School OneDrive. Tap Connect, then sign in with @eastsideprep.org.");
    showOnedriveCode("", "");
  }

  function refreshKeyStatus() {
    const key = localStorage.getItem(LS_KEY) || "";
    const id = providerSel.value || localStorage.getItem(LS_PROV) || "groq";
    if (key) {
      setStatus(keyStatus, `Using your ${id} key · ends ${key.slice(-4)}`);
      return;
    }
    setStatus(keyStatus, "No model key. Groq is the short path: console.groq.com/keys");
  }

  function fillProviders(list) {
    providerSel.innerHTML = "";
    (list || []).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label + (p.recommended ? " · recommended" : "");
      providerSel.appendChild(opt);
    });
    const chosen = localStorage.getItem(LS_PROV) || "groq";
    if ([].some.call(providerSel.options, (o) => o.value === chosen)) {
      providerSel.value = chosen;
    }
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

    try {
      me = await api("/v1/me");
      await loadDashboard();
    } catch {
      loading.hidden = true;
      stage.hidden = false;
      renderHome({ courses: [], assignments: [], files: [] });
      openSheet();
    }
  }

  document.getElementById("settings-open").addEventListener("click", openSheet);
  document.getElementById("settings-close").addEventListener("click", () => {
    closeSheet();
  });
  sheet.addEventListener("click", (ev) => {
    if (ev.target === sheet) closeSheet();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !sheet.hidden) closeSheet();
  });
  appEl.addEventListener("change", (ev) => {
    const input = ev.target.closest("input[data-filter]");
    if (!input) return;
    const tag = input.getAttribute("data-filter");
    if (!tag) return;
    if (input.checked) typeFilter.add(tag);
    else typeFilter.delete(tag);
    if (typeFilter.size === 0) TAGS.forEach((t) => typeFilter.add(t));
    renderHome(lastHome);
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const studentId = form.studentId.value.trim();
    if (!studentId) {
      setStatus(statusEl, "Student ID is required.");
      form.studentId.focus();
      return;
    }
    setStatus(statusEl, "Saving…");
    const payload = {
      school: form.school.value.trim() || "Eastside Prep",
      studentId,
      canvasHost: form.canvasHost.value.trim(),
    };
    const canvasToken = form.canvasToken.value.trim();
    if (canvasToken) payload.canvasToken = canvasToken;
    try {
      me = await api("/v1/me", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      form.canvasToken.value = "";
      setStatus(statusEl, me.displayName ? `Saved · ${me.displayName}` : "Saved.");
      paintOnedrive();
      await loadDashboard();
      closeSheet();
    } catch (err) {
      setStatus(statusEl, err.message || "Could not save.");
    }
  });

  document.getElementById("onedrive-start").addEventListener("click", async () => {
    try {
      if (!me) {
        setStatus(odStatus, "Save school and student ID first.");
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
        clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
          try {
            const st = await api("/v1/me/onedrive/status");
            if (st.connected) {
              clearInterval(pollTimer);
              me = Object.assign({}, me, {
                onedriveConnected: true,
                onedriveEmail: st.email || "",
                onedrivePending: null,
              });
              paintOnedrive();
              await loadDashboard();
            }
          } catch {
            /* keep polling */
          }
        }, 4000);
      } else {
        setStatus(odStatus, started.message || "Microsoft would not start school sign-in.");
        showOnedriveCode("", "");
      }
    } catch (err) {
      setStatus(odStatus, err.message || "Could not start OneDrive.");
    }
  });

  document.getElementById("key-save").addEventListener("click", () => {
    const key = document.getElementById("modelKey").value.trim();
    if (!key) {
      setStatus(keyStatus, "Paste a key first.");
      return;
    }
    localStorage.setItem(LS_KEY, key);
    localStorage.setItem(LS_PROV, providerSel.value || "groq");
    document.getElementById("modelKey").value = "";
    refreshKeyStatus();
  });

  document.getElementById("key-clear").addEventListener("click", () => {
    localStorage.removeItem(LS_KEY);
    document.getElementById("modelKey").value = "";
    refreshKeyStatus();
  });

  providerSel.addEventListener("change", () => {
    localStorage.setItem(LS_PROV, providerSel.value || "groq");
    refreshKeyStatus();
  });

  boot();
})();
