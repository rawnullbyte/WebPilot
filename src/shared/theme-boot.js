/**
 * Applies the browser's light/dark preference before the panel renders.
 *
 * A separate file rather than an inline `<script>`, because the extension CSP
 * (`script-src 'self'`) blocks inline script outright — an inline version of
 * this would silently never run, and the panel would be stuck in light mode on
 * a dark desktop.
 *
 * The CSS keys off a `.dark` class rather than the media query directly, because
 * the in-page panel has to toggle it per-element inside a shadow root, where a
 * media query cannot be scoped to the panel alone.
 */
;(function () {
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)')
    var apply = function () {
      document.documentElement.classList.toggle('dark', mq.matches)
    }
    apply()
    mq.addEventListener('change', apply)
  } catch (e) {
    /* An old engine with no matchMedia: light mode is a fine fallback. */
  }
})()
