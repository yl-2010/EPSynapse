(() => {
  const ARMS = [
    { key: "zero_shot", label: "Zero-shot BERT" },
    { key: "fine_tuned", label: "Fine-tuned BERT" },
    { key: "student_key", label: "Student-key model" },
  ];
  const METRICS = [
    { key: "accuracy", label: "Accuracy" },
    { key: "micro_f1", label: "Micro-F1" },
    { key: "macro_f1", label: "Macro-F1" },
  ];

  const charts = document.getElementById("research-charts");
  const status = document.getElementById("research-status");
  const form = document.getElementById("research-toggles");

  function pct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, v * 100));
  }

  function barGroup(metric, arms) {
    const rows = ARMS.map((arm) => {
      const data = arms[arm.key] || {};
      const value = pct(data[metric.key]);
      return `<div class="research-bar-row">
        <span class="research-bar-label">${arm.label}</span>
        <div class="research-bar-track" aria-hidden="true">
          <span class="research-bar-fill" style="width:${value.toFixed(1)}%"></span>
        </div>
        <span class="research-bar-n">${value.toFixed(1)}%</span>
      </div>`;
    }).join("");
    return `<section class="edu-panel research-chart" data-filter-id="lg-research-${metric.key}">
      <div class="edu-panel-head"><h2 class="edu-panel-title">${metric.label}</h2></div>
      ${rows}
    </section>`;
  }

  function paint(payload) {
    const arms = payload.arms || {};
    const n = Number(payload.test_n) || 0;
    const userN = Number(payload.user_test_n) || 0;
    const frozenN = Number(payload.frozen_test_n) || 0;
    charts.innerHTML = METRICS.map((m) => barGroup(m, arms)).join("");
    charts.hidden = false;
    status.hidden = false;
    status.textContent =
      n === 0
        ? "No scored examples yet. Frozen eval is still zeros."
        : `${n} examples · ${frozenN} eval · ${userN} user`;
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
    try {
      const res = await fetch(
        `${apiBase}/v1/research/metrics?includeUser=${includeUser}&includeFrozen=${includeFrozen}`,
        { credentials: "omit" }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      paint(body);
    } catch (err) {
      charts.hidden = true;
      status.textContent = err.message || "Could not load research metrics.";
    }
  }

  form.addEventListener("change", (ev) => {
    const label = ev.target.closest(".edu-filter");
    if (label && ev.target.type === "checkbox") {
      label.classList.toggle("is-on", ev.target.checked);
    }
    load();
  });

  load();
})();
