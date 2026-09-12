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
      ".c-tr .theme-mode-icon{width:42%;height:42%;pointer-events:none}";
    document.head.appendChild(style);
  }

  const ICONS = {
    sun: `<svg class="theme-mode-icon" viewBox="0 0 221.674 221.843" fill="currentColor" shape-rendering="geometricPrecision" aria-hidden="true"><g transform="matrix(1 0 0 -1 0 221.843)"><path d="M110.848 41.243c5.822 0 10.658-4.909 10.658-10.731V10.679C121.506 4.872 116.67 0 110.848 0s-10.716 4.872-10.716 10.679v19.833c0 5.822 4.836 10.731 10.716 10.731Zm49.21 20.634c4.102 4.071 11.053 4.123 15.218-.109l14.047-13.995c4.013-4.071 3.962-11.095-.109-15.254-4.086-4.056-11.038-3.998-15.145.109L159.949 46.784c-3.983 3.998-3.931 10.949.109 15.093Zm20.416 49.044c0 5.807 4.924 10.731 10.746 10.731h19.672c5.911 0 10.782-4.924 10.782-10.731s-4.871-10.731-10.782-10.731h-19.672c-5.822 0-10.746 4.924-10.746 10.731Zm-20.525 49.263c-3.967 4.071-3.946 10.913.109 15.072l14.156 14.104c4.071 4.071 11.022 3.947 15.181-.182 3.998-4.086 3.977-11.037-.109-15.145l-14.156-13.958c-4.056-4.086-11.007-4.035-15.181.109ZM110.848 180.6c-5.88 0-10.716 4.908-10.716 10.731v19.833c0 5.807 4.836 10.679 10.716 10.679 5.822 0 10.658-4.872 10.658-10.679v-19.833c0-5.823-4.836-10.731-10.658-10.731ZM61.674 160.184c-4.159-4.144-11.183-4.195-15.254-.109L32.409 173.96c-4.144 4.108-4.165 11.059.182 15.145 4.159 4.128 11.126 4.253 15.181.182l14.084-14.032c4.143-4.159 4.164-11.001.182-15.072Zm-20.504-49.263c0-5.807-4.872-10.731-10.752-10.731H10.731C4.836 100.19 0 105.114 0 110.921s4.836 10.731 10.731 10.731h19.687c5.88 0 10.752-4.924 10.752-10.731Zm20.322-49.044c4.128-4.071 4.18-11.095.182-15.093L47.627 32.628c-4.019-4.034-11.059-4.165-15.072-.109-4.128 4.159-4.18 11.183-.182 15.181l13.974 14.068c4.107 4.159 11.058 4.18 15.145.109ZM110.817 162.874c28.651 0 51.953-23.245 51.953-51.953 0-28.708-23.302-51.953-51.953-51.953-28.708 0-52.026 23.245-52.026 51.953 0 28.708 23.318 51.953 52.026 51.953Z"/></g></svg>`,
    moon: `<svg class="theme-mode-icon" viewBox="0 0 200.544 201.288" fill="currentColor" shape-rendering="geometricPrecision" aria-hidden="true"><g transform="rotate(231 100.272 100.644)"><g transform="matrix(1 0 0 -1 0 201.288)"><path d="M102.886 201.288c42.228 0 77.559-25.3 93.276-59.498 4.382-9.559-2.147-15.301-10.295-12.133-7.999 3.088-20.258 5.59-31.084 5.59-55.871 0-87.669-31.725-87.669-87.612 0-10.774 2.668-23.34 6.448-32.452 3.924-9.128-2.481-15.183-11.732-11.098C26.256 19.564 0 55.693 0 98.402 0 155.194 46.116 201.288 102.886 201.288Z"/></g></g></svg>`,
  };

  function paintIcon(resolved) {
    const next = resolved === "dark" ? ICONS.sun : ICONS.moon;
    const cur = el.querySelector(".theme-mode-icon");
    if (cur) cur.outerHTML = next;
    else el.insertAdjacentHTML("afterbegin", next);
    el.setAttribute(
      "aria-label",
      resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"
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
    paintIcon(resolved);
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
