// Replace dvh with the visible viewport, including keyboard resize. Keep 100vh
// as the CSS fallback until this Android-only entry has executed.
const viewport = () =>
  document.documentElement.style.setProperty(
    "--kj-viewport-height",
    `${window.visualViewport?.height || window.innerHeight}px`,
  );
viewport();
window.addEventListener("resize", viewport);
window.visualViewport?.addEventListener("resize", viewport);
