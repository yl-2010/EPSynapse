(() => {
  const LS_SID = "epsynapse.sid";
  const LS_VOTER = "epsynapse.voter";
  const FALLBACK_API = "https://api.epsynapse.com";
  const SCHOOL = "eastside-prep";

  const STATIC_PULSE = {
    id: "lpc-2026-09",
    topic: "LPC",
    title: "This week's LPC",
    blurb: "Four questions. Counts only. No names on the board.",
    status: "open",
    questions: [
      {
        id: "keep",
        prompt: "Keep the current LPC mains?",
        kind: "single",
        options: [
          { id: "keep", label: "Keep them" },
          { id: "drop", label: "Drop them" },
          { id: "rotate", label: "Rotate weekly" },
        ],
      },
      {
        id: "add",
        prompt: "What should LPC add next?",
        kind: "single",
        options: [
          { id: "protein", label: "More protein" },
          { id: "veg", label: "Better vegetarian" },
          { id: "hot", label: "A hot line that is not pizza" },
          { id: "late", label: "A window after 1pm" },
        ],
      },
      {
        id: "diet",
        prompt: "Dietary gap you hit most?",
        kind: "single",
        options: [
          { id: "none", label: "None" },
          { id: "veg", label: "Vegetarian" },
          { id: "vegan", label: "Vegan" },
          { id: "gluten", label: "Gluten" },
          { id: "kosher", label: "Kosher or halal" },
        ],
      },
      {
        id: "wait",
        prompt: "Peak wait in the line?",
        kind: "single",
        options: [
          { id: "fast", label: "Under 3 min" },
          { id: "ok", label: "3 to 6" },
          { id: "slow", label: "6 to 10" },
          { id: "dead", label: "More than 10" },
        ],
      },
    ],
    grades: ["9", "10", "11", "12"],
    voted: false,
    myAnswers: null,
  };

  const titleEl = document.getElementById("pulse-title");
  const blurbEl = document.getElementById("pulse-blurb");
  const statusEl = document.getElementById("pulse-status");
  const formEl = document.getElementById("pulse-form");
  const questionsEl = document.getElementById("pulse-questions");
  const gradesEl = document.getElementById("pulse-grades");
  const sendEl = document.getElementById("pulse-send");
  const thanksEl = document.getElementById("pulse-thanks");
  const thanksTitleEl = document.getElementById("pulse-thanks-title");
  const thanksCopyEl = document.getElementById("pulse-thanks-copy");
  const resultsEl = document.getElementById("pulse-results");
  const rootEl = document.getElementById("pulse-root");

  let apiBase = FALLBACK_API;
  let pulse = STATIC_PULSE;
  let answers = {};
  let grade = "";
  let locked = false;

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function uuid() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function voterId() {
    let id = "";
    try {
      id = localStorage.getItem(LS_VOTER) || "";
    } catch (_) {}
    if (id) return id;
    id = uuid();
    try {
      localStorage.setItem(LS_VOTER, id);
    } catch (_) {}
    return id;
  }

  function sid() {
    try {
      return localStorage.getItem(LS_SID) || "";
    } catch (_) {
      return "";
    }
  }

  function headers(json) {
    const h = {
      Accept: "application/json",
      "X-EPSynapse-Voter": voterId(),
    };
    const session = sid();
    if (session) h["X-EPSynapse-Session"] = session;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function plainError(err, fallback) {
    const raw = err && (err.message || err.error);
    const text = String(raw || fallback || "Something went wrong.");
    const one = text.split("\n")[0].trim();
    if (!one || /at\s+\S+\s+\(/.test(one) || one.length > 180) {
      return fallback || "Something went wrong.";
    }
    return one;
  }

  async function loadConfig() {
    try {
      const res = await fetch("/runtime-config.json", { cache: "no-store" });
      if (!res.ok) return;
      const cfg = await res.json();
      if (cfg && typeof cfg.apiBase === "string" && cfg.apiBase) {
        apiBase = cfg.apiBase.replace(/\/$/, "");
      }
    } catch (_) {}
    window.__epsynapseApiBase = apiBase;
  }

  async function api(path, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      res = await fetch(apiBase + path, {
        credentials: "include",
        ...opts,
        headers: { ...headers(Boolean(opts && opts.body)), ...(opts && opts.headers) },
        signal: ctrl.signal,
      });
    } catch (err) {
      const down = new Error("The Mac API is unreachable. The questions are still on the page.");
      down.network = true;
      down.cause = err;
      throw down;
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch (_) {
      body = {};
    }
    if (body.sessionId) {
      try {
        localStorage.setItem(LS_SID, body.sessionId);
      } catch (_) {}
    }
    if (!res.ok) {
      const err = new Error(body.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  function allAnswered() {
    return pulse.questions.every((q) => answers[q.id]);
  }

  function syncSend() {
    sendEl.disabled = locked || !allAnswered();
  }

  function paintChips() {
    for (const btn of questionsEl.querySelectorAll("[data-qid]")) {
      const on = answers[btn.dataset.qid] === btn.dataset.oid;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.disabled = locked;
    }
    for (const btn of gradesEl.querySelectorAll("[data-grade]")) {
      const value = btn.dataset.grade;
      const on = value === "skip" ? !grade : grade === value;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.disabled = locked;
    }
    syncSend();
  }

  function renderQuestions() {
    questionsEl.innerHTML = pulse.questions
      .map((q) => {
        const chips = (q.options || [])
          .map(
            (o) =>
              `<button type="button" class="pulse-chip" data-qid="${escapeHtml(q.id)}" data-oid="${escapeHtml(o.id)}" aria-pressed="false">${escapeHtml(o.label)}</button>`
          )
          .join("");
        return `<section class="pulse-block" data-question="${escapeHtml(q.id)}"><h2 class="pulse-q">${escapeHtml(q.prompt)}</h2><div class="pulse-chips" role="group" aria-label="${escapeHtml(q.prompt)}">${chips}</div></section>`;
      })
      .join("");

    const grades = pulse.grades && pulse.grades.length ? pulse.grades : ["9", "10", "11", "12"];
    gradesEl.innerHTML =
      grades
        .map(
          (g) =>
            `<button type="button" class="pulse-chip" data-grade="${escapeHtml(g)}" aria-pressed="false">${escapeHtml(g)}</button>`
        )
        .join("") +
      `<button type="button" class="pulse-chip" data-grade="skip" aria-pressed="true">Skip</button>`;
    paintChips();
  }

  function optionPct(opt, n) {
    if (Number.isFinite(opt.pct)) return Math.max(0, Math.round(opt.pct));
    if (n > 0 && Number.isFinite(opt.count)) return Math.max(0, Math.round((opt.count / n) * 100));
    return 0;
  }

  function renderResults(results) {
    if (!results || !Array.isArray(results.questions)) {
      resultsEl.innerHTML = "";
      return;
    }
    const n = Number(results.n) || 0;
    const blocks = results.questions
      .map((q) => {
        const rows = (q.options || [])
          .map((o) => {
            const pct = optionPct(o, n);
            return `<div class="pulse-row"><span class="pulse-row-label">${escapeHtml(o.label)}</span><span class="pulse-row-pct">${pct}%</span><div class="pulse-bar" aria-hidden="true"><i style="width:${pct}%"></i></div></div>`;
          })
          .join("");
        return `<section class="pulse-tally"><h3>${escapeHtml(q.prompt || q.id)}</h3>${rows}</section>`;
      })
      .join("");
    const countLine = n
      ? `<p class="pulse-n">${n} ${n === 1 ? "answer" : "answers"} so far</p>`
      : "";
    resultsEl.innerHTML = countLine + blocks;
  }

  function showThanks(already, results) {
    locked = true;
    rootEl.classList.add("is-locked");
    sendEl.hidden = true;
    thanksEl.hidden = false;
    thanksTitleEl.textContent = already ? "You already voted" : "Counted.";
    thanksCopyEl.textContent = results
      ? "Here's where it stands."
      : "The board will show the tally once the API is up.";
    if (results) renderResults(results);
    paintChips();
  }

  function applyPulse(next, results) {
    pulse = next;
    titleEl.textContent = pulse.title || "This week's LPC";
    blurbEl.textContent = pulse.blurb || "Four questions. Counts only.";
    answers = {};
    grade = "";
    if (pulse.myAnswers && typeof pulse.myAnswers === "object") {
      answers = { ...pulse.myAnswers };
      if (answers.grade) {
        grade = String(answers.grade);
        delete answers.grade;
      }
    }
    if (pulse.myGrade) grade = String(pulse.myGrade);
    renderQuestions();
    if (pulse.voted) showThanks(true, results);
  }

  async function fetchResultsAfterVoted() {
    if (!pulse.id || !allAnswered()) return null;
    try {
      const body = { answers: { ...answers } };
      if (grade) body.grade = grade;
      const data = await api(`/v1/pulses/${encodeURIComponent(pulse.id)}/vote`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return data.results || null;
    } catch (err) {
      if (err.body && err.body.results) return err.body.results;
    }
    return null;
  }

  async function loadPulse() {
    try {
      const data = await api(`/v1/pulses/current?school=${encodeURIComponent(SCHOOL)}`);
      const next = data && data.pulse;
      if (next && Array.isArray(next.questions) && next.questions.length) {
        applyPulse(next, data.results || next.results || null);
        if (next.voted && !data.results && !next.results) {
          const results = await fetchResultsAfterVoted();
          if (results) renderResults(results);
        }
        return;
      }
    } catch (err) {
      if (err.status === 404) return;
      if (err.network) {
        setStatus("The Mac API is unreachable. The questions are still on the page.");
        return;
      }
      setStatus(plainError(err, "Could not load this week's pulse."));
    }
  }

  questionsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-qid]");
    if (!btn || locked) return;
    answers[btn.dataset.qid] = btn.dataset.oid;
    paintChips();
  });

  gradesEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-grade]");
    if (!btn || locked) return;
    grade = btn.dataset.grade === "skip" ? "" : btn.dataset.grade;
    paintChips();
  });

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (locked || !allAnswered()) return;
    sendEl.disabled = true;
    setStatus("");
    const payload = { answers: { ...answers } };
    if (grade) payload.grade = grade;
    try {
      const data = await api(`/v1/pulses/${encodeURIComponent(pulse.id)}/vote`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showThanks(false, data.results || null);
    } catch (err) {
      if (err.status === 409) {
        showThanks(true, err.body && err.body.results);
        return;
      }
      if (err.network) {
        setStatus("The Mac API is unreachable. Your answers stayed on this page.");
      } else if (err.status === 404) {
        setStatus("This pulse is not on the API yet. Your answers stayed on this page.");
      } else {
        setStatus(plainError(err, "Could not send your vote."));
      }
      syncSend();
    }
  });

  applyPulse(STATIC_PULSE, null);
  loadConfig()
    .then(loadPulse)
    .catch(() => {
      setStatus("The Mac API is unreachable. The questions are still on the page.");
    });
})();
