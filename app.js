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
  const olStatus = document.getElementById("outlook-status");
  const keyStatus = document.getElementById("key-status");
  const providerSel = document.getElementById("provider");

  let apiBase = "";
  let me = null;
  let odPollTimer = 0;
  let olPollTimer = 0;
  const TAGS = ["CW", "HW", "QA", "MA"];
  const typeFilter = new Set(TAGS);
  let lastHome = { courses: [], assignments: [], files: [], messages: [] };
  let openMail = null;
  let mailBusy = false;

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

  function openSheet() {
    sheet.hidden = false;
    if (me) {
      form.school.value = me.school || "Eastside Prep";
      form.studentId.value = me.studentId || "";
      form.canvasHost.value = me.canvasHost || "https://eastsideprep.instructure.com";
    }
    refreshKeyStatus();
    paintOnedrive();
    paintOutlook();
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

  function renderHome({ courses, assignments, files, messages }) {
    lastHome = { courses, assignments, files, messages: messages || lastHome.messages || [] };
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
          ${panelHtml("Mail", mailPanelHtml(lastHome.messages), "lg-edu-mail")}
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
      ? api("/v1/me/onedrive/files", { timeoutMs: 20000 }).then((r) => r.files || []).catch(() => [])
      : Promise.resolve([]);
    const messages = me?.outlookConnected
      ? api("/v1/me/outlook/messages?limit=12", { timeoutMs: 20000 }).then((r) => r.messages || []).catch(() => [])
      : Promise.resolve([]);
    renderHome({
      courses: await courses,
      assignments: await assignments,
      files: await files,
      messages: await messages,
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
    if (!me) {
      setStatus(olStatus, "School Outlook. Same Microsoft sign-in, mail only.");
      showOutlookCode("", "");
      return;
    }
    if (me.outlookConnected) {
      setStatus(olStatus, me.outlookEmail ? `Outlook · ${me.outlookEmail}` : "Outlook connected");
      showOutlookCode("", "");
      return;
    }
    const p = me.outlookPending;
    if (p && (p.user_code || p.verification_uri)) {
      setStatus(
        olStatus,
        "Enter this code on the Microsoft page, then sign in with your school email. Allow mail access."
      );
      showOutlookCode(p.user_code, p.verification_uri || "https://login.microsoft.com/device");
      return;
    }
    setStatus(olStatus, "School Outlook. Same Microsoft sign-in, mail only.");
    showOutlookCode("", "");
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
      renderHome({ courses: [], assignments: [], files: [], messages: [] });
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
      paintOutlook();
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
        clearInterval(odPollTimer);
        odPollTimer = setInterval(async () => {
          try {
            const st = await api("/v1/me/onedrive/status", { timeoutMs: 15000 });
            if (st.connected) {
              clearInterval(odPollTimer);
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

  document.getElementById("outlook-start").addEventListener("click", async () => {
    try {
      if (!me) {
        setStatus(olStatus, "Save school and student ID first.");
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
        if (started.verification_uri) window.open(started.verification_uri, "_blank", "noopener");
        clearInterval(olPollTimer);
        olPollTimer = setInterval(async () => {
          try {
            const st = await api("/v1/me/outlook/status", { timeoutMs: 15000 });
            if (st.connected) {
              clearInterval(olPollTimer);
              me = Object.assign({}, me, {
                outlookConnected: true,
                outlookEmail: st.email || "",
                outlookPending: null,
              });
              paintOutlook();
              await loadDashboard();
            } else if (st.pending && (st.pending.user_code || st.pending.verification_uri)) {
              me = Object.assign({}, me, { outlookPending: st.pending });
              paintOutlook();
            }
          } catch {
            /* keep polling */
          }
        }, 4000);
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
      renderHome(lastHome);
    } catch (err) {
      openMail = { subject: "Could not open", body: err.message || "Read failed." };
      renderHome(lastHome);
    }
  });

  appEl.addEventListener("submit", async (ev) => {
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
    renderHome(lastHome);
    try {
      const sent = await api("/v1/me/outlook/send", {
        method: "POST",
        body: JSON.stringify({ to, subject, body }),
        timeoutMs: 25000,
      });
      mailBusy = false;
      openMail = null;
      renderHome(lastHome);
      const again = document.getElementById("outlook-send-status");
      if (again) again.textContent = sent.sent ? `Sent to ${sent.to}` : "Sent.";
    } catch (err) {
      mailBusy = false;
      renderHome(lastHome);
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
