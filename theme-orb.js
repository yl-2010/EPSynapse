/**
 * Top-right liquid-glass circle for non-main pages.
 * Draggable (snaps home near top-right); click toggles light/dark theme.
 * Theme is session-only — no YouTube / link behavior.
 */
(() => {
  const el = document.querySelector(".c-tr");
  if (!el) return;

  if (!document.getElementById("theme-mode-icon-style")) {
    const style = document.createElement("style");
    style.id = "theme-mode-icon-style";
    style.textContent =
      ".c-tr .theme-mode-icon{width:38%;height:38%;pointer-events:none}";
    document.head.appendChild(style);
  }

  if (!el.querySelector(".theme-mode-icon")) {
    // Same stack as ios CornerChrome: circle.fill #F2F2F7 under
    // circle.lefthalf.filled #1C1C1E, Semibold, 38% of the orb.
    el.insertAdjacentHTML(
      "afterbegin",
      `<svg class="theme-mode-icon" viewBox="0 0 203.682 203.593" shape-rendering="geometricPrecision" aria-hidden="true">
        <g transform="matrix(1 0 0 -1 0 203.593)">
          <path fill="#f2f2f7" d="M101.796606 203.593368C158.01282 203.593368 203.681509 157.93996 203.681509 101.796762S158.01282.000155 101.796606.000155 0 45.653563 0 101.796762s45.653408 101.796606 101.796606 101.796606Z"/>
          <path fill="#1c1c1e" fill-rule="evenodd" d="M101.796606 192.674182V10.919341C50.112072 10.919341 10.9922 50.096946 10.9922 101.796762S50.112072 192.674182 101.796606 192.674182ZM101.796606 203.593368C158.043382 203.593368 203.681509 158.043538 203.681509 101.796762S158.043382.000155 101.796606.000155 0 45.549986 0 101.796762s45.638126 101.796606 101.796606 101.796606ZM101.796606 181.26136C57.875212 181.26136 22.389741 145.718155 22.389741 101.796762S57.875212 22.332163 101.796606 22.332163s79.479881 35.543205 79.479881 79.464599-35.543205 79.464598-79.479881 79.464598Z"/>
        </g>
      </svg>`
    );
  }

  /** @typedef {"light"|"dark"|"system"} ThemePreference */
  /** @typedef {"light"|"dark"} ResolvedTheme */

  /** @type {ThemePreference} */
  let themePreference = "system";
  const HOME_SNAP = 90;

  /** @param {ThemePreference} preference @returns {ResolvedTheme} */
  function resolveTheme(preference) {
    if (preference === "dark") return "dark";
    if (preference === "light") return "light";
    if (typeof window.__resolveSystemTheme === "function") {
      const resolved = window.__resolveSystemTheme();
      if (resolved === "dark" || resolved === "light") return resolved;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  /** @param {ThemePreference} preference @returns {ResolvedTheme} */
  function applyTheme(preference) {
    themePreference = preference;
    const resolved = resolveTheme(preference);
    const html = document.documentElement;
    html.setAttribute("data-theme", preference);
    html.setAttribute("data-resolved-theme", resolved);
    html.style.colorScheme = resolved;
    void html.offsetHeight;
    if (typeof window.reinitLiquidGlass === "function") {
      window.reinitLiquidGlass();
    }
    return resolved;
  }

  function toggleTheme() {
    const current = resolveTheme(themePreference);
    applyTheme(current === "dark" ? "light" : "dark");
  }

  window.__refreshSiteTheme = () => applyTheme(themePreference);

  // Keep in sync with the head bootstrap (system).
  applyTheme("system");

  const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onSchemeChange = () => {
    if (themePreference !== "system") return;
    applyTheme("system");
  };
  if (typeof schemeQuery.addEventListener === "function") {
    schemeQuery.addEventListener("change", onSchemeChange);
  } else if (typeof schemeQuery.addListener === "function") {
    schemeQuery.addListener(onSchemeChange);
  }

  function applyT(node) {
    if (typeof window.__lgApplyTransform === "function") {
      window.__lgApplyTransform(node);
      return;
    }
    const bx = node._bx || 0;
    const by = node._by || 0;
    const mx = node._mx || 0;
    const my = node._my || 0;
    node.style.transform = `translate(${bx + mx}px, ${by + my}px)`;
  }

  function snapOrbHome(node) {
    node._bx = 0;
    node._by = 0;
    node._mx = 0;
    node._my = 0;
    applyT(node);
  }

  el.removeAttribute("href");
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (el._moved) return;
    toggleTheme();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (el._moved) return;
    toggleTheme();
  });
  el.addEventListener("dragstart", (e) => e.preventDefault());

  el.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    el._drag = true;
    el._moved = false;
    el.classList.add("is-dragging");
    try {
      el.setPointerCapture(e.pointerId);
    } catch (_) {}
    el._sx = e.clientX - (el._bx || 0);
    el._sy = e.clientY - (el._by || 0);
    el._mx = 0;
    el._my = 0;
  });

  el.addEventListener("pointermove", (e) => {
    if (!el._drag) return;
    const nx = e.clientX - el._sx;
    const ny = e.clientY - el._sy;
    if (Math.hypot(nx - (el._bx || 0), ny - (el._by || 0)) > 4) {
      el._moved = true;
    }
    el._bx = nx;
    el._by = ny;
    applyT(el);
  });

  const end = () => {
    if (!el._drag) return;
    el._drag = false;
    el.classList.remove("is-dragging");
    if (Math.hypot(el._bx || 0, el._by || 0) < HOME_SNAP) {
      snapOrbHome(el);
    }
  };

  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("lostpointercapture", end);
})();
