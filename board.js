(() => {
  const SCHOOL = "eastside-prep";
  const POLL_MS = 4000;
  const GRADES = ["9", "10", "11", "12"];
  const FALLBACK_ID = "lpc-2026-09";

  const FALLBACK_QUESTIONS = [
    {
      id: "keep",
      prompt: "Keep the current LPC mains?",
      options: [
        { id: "keep", label: "Keep them" },
        { id: "drop", label: "Drop them" },
        { id: "rotate", label: "Rotate weekly" },
      ],
    },
    {
      id: "add",
      prompt: "What should LPC add next?",
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
      options: [
        { id: "fast", label: "Under 3 min" },
        { id: "ok", label: "3 to 6" },
        { id: "slow", label: "6 to 10" },
        { id: "dead", label: "More than 10" },
      ],
    },
  ];

  const titleEl = document.getElementById("board-title");
  const nEl = document.getElementById("board-n");
  const liveEl = document.getElementById("board-live");
  const statusEl = document.getElementById("board-status");
  const questionsEl = document.getElementById("board-questions");
  const skipEl = document.getElementById("board-skip");
  const csvBtn = document.getElementById("board-csv");

  let apiBase = "https://api.epsynapse.com";
  let pulseId = "";
  let view = "all";
  let snapshot = emptyResults();
  let live = false;
  let timer = 0;
  let inflight = false;

  function emptyByGrade(questions) {
    const byGrade = {};
    for (const grade of GRADES) {
      const options = {};
      for (const q of questions) {
        const row = {};
        for (const opt of q.options) row[opt.id] = 0;
        options[q.id] = row;
      }
      byGrade[grade] = { n: 0, options };
    }
    return byGrade;
  }

  function emptyResults() {
    const questions = FALLBACK_QUESTIONS.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: q.options.map((opt) => ({ ...opt, count: 0, pct: 0 })),
    }));
    return {
      id: FALLBACK_ID,
      title: "This week's LPC",
      topic: "LPC",
      status: "open",
      n: 0,
      updatedAt: null,
      questions,
      byGrade: emptyByGrade(questions),
      skippedGrade: 0,
    };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function answersLabel(n) {
    const count = Number.isFinite(n) ? n : 0;
    return count === 1 ? "1 answer" : `${count} answers`;
  }

  function optionPct(opt) {
    const pct = Number(opt.pct);
    if (Number.isFinite(pct)) return Math.max(0, Math.min(100, pct));
    return 0;
  }

  function optionCount(opt) {
    const count = Number(opt.count);
    return Number.isFinite(count) ? count : 0;
  }

  function gradeCount(byGrade, grade, qid, oid) {
    const raw = byGrade?.[grade]?.options?.[qid]?.[oid];
    const count = Number(raw);
    return Number.isFinite(count) ? count : 0;
  }

  function setLive(ok, message) {
    live = ok;
    liveEl.dataset.state = ok ? "live" : "down";
    liveEl.querySelector(".board-live-label").textContent = ok ? "live" : "offline";
    statusEl.textContent = message || "";
  }

  function renderAll(results) {
    questionsEl.innerHTML = results.questions
      .map((q) => {
        const rows = (q.options || [])
          .map((opt) => {
            const count = optionCount(opt);
            const pct = optionPct(opt);
            return `<div class="board-row">
              <p class="board-opt">${escapeHtml(opt.label)}</p>
              <p class="board-stat">${count} · ${pct}%</p>
              <div class="board-track" role="presentation">
                <span class="board-fill" style="width:${pct}%"></span>
              </div>
            </div>`;
          })
          .join("");
        return `<article class="board-card">
          <h2 class="board-prompt">${escapeHtml(q.prompt)}</h2>
          ${rows}
        </article>`;
      })
      .join("");
  }

  function renderGrades(results) {
    const byGrade = results.byGrade || {};
    questionsEl.innerHTML = results.questions
      .map((q) => {
        const heads = (q.options || [])
          .map((opt) => `<th scope="col">${escapeHtml(opt.label)}</th>`)
          .join("");
        const body = GRADES.map((grade) => {
          const cells = (q.options || [])
            .map((opt) => `<td>${gradeCount(byGrade, grade, q.id, opt.id)}</td>`)
            .join("");
          return `<tr><th scope="row">${grade}</th>${cells}</tr>`;
        }).join("");
        return `<article class="board-card">
          <h2 class="board-prompt">${escapeHtml(q.prompt)}</h2>
          <div class="board-grades">
            <table class="board-table">
              <thead><tr><th scope="col">Grade</th>${heads}</tr></thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        </article>`;
      })
      .join("");
  }

  function render(results) {
    snapshot = results;
    titleEl.textContent = results.title || "This week's LPC";
    nEl.textContent = answersLabel(results.n);
    if (view === "grade") renderGrades(results);
    else renderAll(results);
    const skipped = Number(results.skippedGrade);
    if (Number.isFinite(skipped) && skipped > 0) {
      skipEl.hidden = false;
      skipEl.textContent =
        skipped === 1 ? "1 answer with no grade" : `${skipped} answers with no grade`;
    } else {
      skipEl.hidden = true;
      skipEl.textContent = "";
    }
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function localCsv(results) {
    const lines = ["kind,question_id,option_id,grade,count,pct"];
    for (const q of results.questions) {
      for (const opt of q.options || []) {
        lines.push(
          ["option", q.id, opt.id, "", optionCount(opt), optionPct(opt)]
            .map(csvEscape)
            .join(",")
        );
      }
    }
    const byGrade = results.byGrade || {};
    for (const grade of GRADES) {
      for (const q of results.questions) {
        for (const opt of q.options || []) {
          lines.push(
            ["grade", q.id, opt.id, grade, gradeCount(byGrade, grade, q.id, opt.id), ""]
              .map(csvEscape)
              .join(",")
          );
        }
      }
    }
    lines.push(
      ["skipped", "", "", "", Number(results.skippedGrade) || 0, ""].map(csvEscape).join(",")
    );
    return `${lines.join("\n")}\n`;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function resolveApiBase() {
    try {
      const runtime = await fetch("/runtime-config.json", { cache: "no-store" }).then((r) =>
        r.json()
      );
      const host = location.hostname;
      if (host === "localhost" || host === "127.0.0.1") {
        return runtime.localApiBase || "http://127.0.0.1:3006";
      }
      return runtime.apiBase || "https://api.epsynapse.com";
    } catch {
      return "https://api.epsynapse.com";
    }
  }

  async function apiGet(path) {
    const res = await fetch(apiBase + path, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function readPulseId(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (payload.pulse && typeof payload.pulse.id === "string") return payload.pulse.id;
    if (typeof payload.id === "string") return payload.id;
    return "";
  }

  function normalizeResults(raw) {
    if (!raw || !Array.isArray(raw.questions) || !raw.questions.length) {
      return emptyResults();
    }
    const questions = raw.questions.map((q) => ({
      id: String(q.id || ""),
      prompt: String(q.prompt || ""),
      options: (q.options || []).map((opt) => ({
        id: String(opt.id || ""),
        label: String(opt.label || ""),
        count: optionCount(opt),
        pct: optionPct(opt),
      })),
    }));
    const byGrade = emptyByGrade(questions);
    for (const grade of GRADES) {
      const src = raw.byGrade?.[grade];
      if (!src) continue;
      const n = Number(src.n);
      byGrade[grade].n = Number.isFinite(n) ? n : 0;
      for (const q of questions) {
        const row = src.options?.[q.id] || {};
        for (const opt of q.options) {
          const count = Number(row[opt.id]);
          byGrade[grade].options[q.id][opt.id] = Number.isFinite(count) ? count : 0;
        }
      }
    }
    const skipped = Number(raw.skippedGrade);
    return {
      id: String(raw.id || pulseId || FALLBACK_ID),
      title: String(raw.title || "This week's LPC"),
      topic: String(raw.topic || "LPC"),
      status: String(raw.status || "open"),
      n: Number.isFinite(Number(raw.n)) ? Number(raw.n) : 0,
      updatedAt: raw.updatedAt || null,
      questions,
      byGrade,
      skippedGrade: Number.isFinite(skipped) ? skipped : 0,
    };
  }

  async function tick() {
    if (inflight) return;
    inflight = true;
    try {
      if (!pulseId) {
        const current = await apiGet(`/v1/pulses/current?school=${SCHOOL}`);
        pulseId = readPulseId(current);
        if (current?.pulse?.title) titleEl.textContent = current.pulse.title;
      }
      if (!pulseId) throw new Error("No pulse");
      const raw = await apiGet(`/v1/pulses/${encodeURIComponent(pulseId)}/results`);
      render(normalizeResults(raw));
      setLive(true, "");
    } catch {
      if (!pulseId) render(emptyResults());
      setLive(false, "API unreachable");
    } finally {
      inflight = false;
    }
  }

  function stopPoll() {
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  }

  function startPoll() {
    stopPoll();
    if (document.hidden) return;
    timer = setInterval(tick, POLL_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPoll();
      return;
    }
    tick();
    startPoll();
  });

  document.querySelectorAll(".board-view").forEach((btn) => {
    btn.addEventListener("click", () => {
      view = btn.dataset.view === "grade" ? "grade" : "all";
      document.querySelectorAll(".board-view").forEach((other) => {
        other.setAttribute("aria-pressed", other === btn ? "true" : "false");
      });
      render(snapshot);
    });
  });

  csvBtn.addEventListener("click", async () => {
    const id = pulseId || snapshot.id || FALLBACK_ID;
    const name = `${id}-counts.csv`;
    if (live && pulseId) {
      try {
        const res = await fetch(`${apiBase}/v1/pulses/${encodeURIComponent(pulseId)}/export.csv`, {
          credentials: "include",
          cache: "no-store",
        });
        if (res.ok) {
          saveBlob(await res.blob(), name);
          return;
        }
      } catch {
        /* fall through to local counts */
      }
    }
    saveBlob(new Blob([localCsv(snapshot)], { type: "text/csv;charset=utf-8" }), name);
  });

  render(snapshot);
  setLive(false, "");

  (async () => {
    apiBase = await resolveApiBase();
    await tick();
    startPoll();
  })();
})();
