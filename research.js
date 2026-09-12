(() => {
  const ARMS = [
    { key: "zero_shot", label: "BERT" },
    { key: "fine_tuned", label: "Fine-tuned BERT" },
  ];
  const METRICS = [
    { key: "accuracy", label: "Accuracy", color: "var(--research-acc)" },
    { key: "micro_f1", label: "Micro-F1", color: "var(--research-micro)" },
    { key: "macro_f1", label: "Macro-F1", color: "var(--research-macro)" },
  ];
  const INCLUDE_USER_KEY = "eps-research-include-user";
  const INCLUDE_EVAL_KEY = "eps-research-include-eval";

  const body = document.getElementById("research-body");
  const status = document.getElementById("research-status");
  const updated = document.getElementById("research-updated");
  const form = document.getElementById("research-toggles");
  const hint = document.getElementById("research-hint");
  const userLabel = document.getElementById("research-user-label");

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function num(value) {
    const v = Number(value);
    return Number.isFinite(v) ? v : 0;
  }

  function pct(value) {
    if (typeof value !== "number" || Number.isNaN(value)) return "—";
    return `${(value * 100).toFixed(1)}%`;
  }

  function dayOrdinal(day) {
    const mod100 = day % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
    switch (day % 10) {
      case 1:
        return `${day}st`;
      case 2:
        return `${day}nd`;
      case 3:
        return `${day}rd`;
      default:
        return `${day}th`;
    }
  }

  function formatUpdatedStamp(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      })
        .formatToParts(date)
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value])
    );
    const day = Number(parts.day);
    const period = (parts.dayPeriod || "am").toLowerCase();
    return `${parts.month} ${dayOrdinal(day)} ${parts.year}, ${parts.hour}:${parts.minute}:${parts.second} ${period} pacific`;
  }

  function readPref(key, fallback) {
    try {
      const raw = sessionStorage.getItem(key);
      if (raw === null) return fallback;
      return raw !== "0";
    } catch {
      return fallback;
    }
  }

  function writePref(key, on) {
    try {
      sessionStorage.setItem(key, on ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function applyPrefs() {
    let userOn = readPref(INCLUDE_USER_KEY, false);
    let evalOn = readPref(INCLUDE_EVAL_KEY, true);
    if (!userOn && !evalOn) {
      evalOn = true;
      writePref(INCLUDE_EVAL_KEY, true);
    }
    form.includeUser.checked = userOn;
    form.includeFrozen.checked = evalOn;
  }

  function setHint() {
    const userOn = form.includeUser.checked;
    const evalOn = form.includeFrozen.checked;
    if (userOn && evalOn) {
      hint.textContent = "Charts pool the original eval set with live classifications from every user.";
    } else if (userOn) {
      hint.textContent = "Charts show only live classifications from every user.";
    } else {
      hint.textContent = "Charts show only the original offline eval run.";
    }
  }

  function orderedArms(payload) {
    const raw = payload.arms || {};
    return ARMS.filter((arm) => raw[arm.key]).map((arm) => {
      const data = raw[arm.key] || {};
      return {
        key: arm.key,
        label: data.label || arm.label,
        accuracy: num(data.accuracy),
        micro_f1: num(data.micro_f1 ?? data.accuracy),
        macro_f1: num(data.macro_f1),
        per_class: data.per_class || {},
      };
    });
  }

  function clusteredChart(arms) {
    const chartH = 220;
    const padTop = 16;
    const padBottom = 48;
    const padLeft = 40;
    const padRight = 16;
    const innerH = chartH - padTop - padBottom;
    const groupGap = 48;
    const barW = 22;
    const clusterW = barW * METRICS.length;
    const width =
      padLeft + padRight + arms.length * clusterW + Math.max(0, arms.length - 1) * groupGap + 24;
    const y = (v) => padTop + innerH * (1 - Math.min(1, Math.max(0, v)));

    const ticks = [0, 0.25, 0.5, 0.75, 1]
      .map(
        (tick) => `<g>
          <line class="research-grid" x1="${padLeft}" x2="${width - padRight}" y1="${y(tick)}" y2="${y(tick)}" />
          <text class="research-tick" x="${padLeft - 8}" y="${y(tick) + 4}" text-anchor="end">${Math.round(tick * 100)}</text>
        </g>`
      )
      .join("");

    const groups = arms
      .map((arm, gi) => {
        const gx = padLeft + 12 + gi * (clusterW + groupGap);
        const bars = METRICS.map((metric, mi) => {
          const val = arm[metric.key] ?? 0;
          const bh = innerH * Math.min(1, Math.max(0, val));
          const x = gx + mi * barW;
          const i = gi * 3 + mi;
          return `<g>
            <rect class="research-bar" x="${x}" y="${y(val)}" width="${barW}" height="${bh}" fill="${metric.color}" style="--i:${i}">
              <title>${escapeHtml(arm.label)} · ${metric.label}: ${(val * 100).toFixed(1)}%</title>
            </rect>
          </g>`;
        }).join("");
        return `<g>
          ${bars}
          <text class="research-group" x="${gx + clusterW / 2}" y="${chartH - 18}" text-anchor="middle">${escapeHtml(arm.label)}</text>
        </g>`;
      })
      .join("");

    const legend = METRICS.map(
      (metric) =>
        `<span class="research-legend-item"><i class="research-swatch" style="background:${metric.color}" aria-hidden="true"></i>${metric.label}</span>`
    ).join("");

    return `<figure class="research-chart">
      <svg class="research-svg" viewBox="0 0 ${width} ${chartH}" role="img" aria-label="Accuracy, micro-F1, and macro-F1 by classifier">
        ${ticks}
        ${groups}
      </svg>
      <figcaption class="research-legend">${legend}</figcaption>
    </figure>`;
  }

  function comparisonTable(arms) {
    const rows = arms
      .map(
        (arm) => `<tr>
          <td>${escapeHtml(arm.label)}</td>
          <td>${pct(arm.accuracy)}</td>
          <td>${pct(arm.micro_f1)}</td>
          <td>${pct(arm.macro_f1)}</td>
        </tr>`
      )
      .join("");
    return `<div class="table-scroll">
      <table class="research-table">
        <thead>
          <tr>
            <th>System</th>
            <th>Accuracy</th>
            <th>Micro-F1</th>
            <th>Macro-F1</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  function perClassTable(payload, arms) {
    const subjects = Array.isArray(payload.subjects) ? payload.subjects : [];
    const rows = subjects
      .map((subject) => {
        const values = arms.map((arm) => {
          const f1 = arm.per_class?.[subject]?.f1;
          return typeof f1 === "number" && !Number.isNaN(f1) ? f1 : null;
        });
        const numeric = values.filter((v) => v !== null);
        const maxF1 = numeric.length ? Math.max(...numeric) : null;
        const cells = values
          .map((f1) => {
            const text = pct(f1);
            return f1 !== null && f1 === maxF1 ? `<td><strong>${text}</strong></td>` : `<td>${text}</td>`;
          })
          .join("");
        return `<tr><td>${escapeHtml(subject)}</td>${cells}</tr>`;
      })
      .join("");
    const head = arms.map((arm) => `<th>${escapeHtml(arm.label)}</th>`).join("");
    return `<div class="table-scroll">
      <table class="research-table research-table--dense">
        <thead>
          <tr>
            <th>Subject</th>
            ${head}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  function paint(payload) {
    const arms = orderedArms(payload);
    const userN = Number(payload.user_test_n);
    if (userLabel) {
      userLabel.textContent =
        Number.isFinite(userN) && userN > 0 ? `Include ${userN} user tests` : "Include user tests";
    }
    setHint();

    if (!arms.length) {
      body.hidden = true;
      body.innerHTML = "";
      status.hidden = false;
      status.textContent = "No scored examples yet. Frozen eval is still zeros.";
      updated.hidden = true;
      return;
    }

    body.hidden = false;
    body.innerHTML = `
      <section class="edu-panel research-panel" data-filter-id="lg-research-compare">
        <div class="edu-panel-head"><h2 class="edu-panel-title" id="headline-metrics">Classifier comparison</h2></div>
        ${clusteredChart(arms)}
        ${comparisonTable(arms)}
      </section>
      <section class="edu-panel research-panel" data-filter-id="lg-research-perclass">
        <div class="edu-panel-head"><h2 class="edu-panel-title" id="per-class">Per-class F1</h2></div>
        ${perClassTable(payload, arms)}
      </section>
    `;
    status.hidden = true;
    status.textContent = "";

    const stamp = payload.updated_at || payload.frozen_updated_at || "";
    if (stamp) {
      updated.hidden = false;
      updated.textContent = `Updated ${formatUpdatedStamp(stamp)}`;
    } else {
      updated.hidden = true;
      updated.textContent = "";
    }
    if (typeof window.reinitLiquidGlass === "function") window.reinitLiquidGlass();
  }

  async function load() {
    let apiBase = "";
    try {
      const runtime = await fetch("/runtime-config.json", { cache: "no-store" }).then((r) => r.json());
      const host = location.hostname;
      apiBase =
        host === "localhost" || host === "127.0.0.1"
          ? runtime.localApiBase || "http://127.0.0.1:3006"
          : runtime.apiBase || "";
    } catch {
      apiBase = "http://127.0.0.1:3006";
    }

    const includeUser = form.includeUser.checked ? "1" : "0";
    const includeFrozen = form.includeFrozen.checked ? "1" : "0";
    status.hidden = false;
    status.textContent = "Loading metrics…";
    setHint();
    try {
      const res = await fetch(
        `${apiBase}/v1/research/metrics?includeUser=${includeUser}&includeFrozen=${includeFrozen}`,
        { credentials: "omit" }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
      paint(payload);
    } catch (err) {
      body.hidden = true;
      body.innerHTML = "";
      status.hidden = false;
      status.textContent = err.message || "Could not load research metrics.";
    }
  }

  form.addEventListener("change", (ev) => {
    const box = ev.target;
    if (box.name === "includeUser") {
      if (!box.checked && !form.includeFrozen.checked) {
        form.includeFrozen.checked = true;
        writePref(INCLUDE_EVAL_KEY, true);
      }
      writePref(INCLUDE_USER_KEY, box.checked);
    }
    if (box.name === "includeFrozen") {
      if (!box.checked && !form.includeUser.checked) {
        form.includeUser.checked = true;
        writePref(INCLUDE_USER_KEY, true);
      }
      writePref(INCLUDE_EVAL_KEY, box.checked);
    }
    load();
  });

  applyPrefs();
  load();
})();
