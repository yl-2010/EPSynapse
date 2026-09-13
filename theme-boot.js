/**
 * Theme bootstrap. Runs before styles paint so the first frame matches the OS
 * color scheme. Lives in its own file so the page CSP can stay 'self' only,
 * with no inline script hashes to keep in sync.
 */
(function () {
  try {
    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var r = document.documentElement;
    r.dataset.theme = "system";
    r.dataset.resolvedTheme = dark ? "dark" : "light";
    r.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {}
})();
