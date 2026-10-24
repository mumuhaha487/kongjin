// Test-only removal of APIs introduced after Chrome/WebView 87. Imported by
// smoke and real-local-integration scripts, never by the application.
export async function legacyEnvironment(context, compression = "missing") {
  await context.addInitScript((mode) => {
    window.__legacyNativeStreams = { CompressionStream, DecompressionStream };
    const remove = (object, key) => {
      try {
        delete object[key];
      } catch {
        /* test browser */
      }
    };
    for (const method of [
      "at",
      "findLast",
      "findLastIndex",
      "toSorted",
      "toReversed",
      "toSpliced",
      "with",
    ])
      remove(Array.prototype, method);
    remove(String.prototype, "at");
    remove(Object, "hasOwn");
    remove(window, "structuredClone");
    remove(crypto, "randomUUID");
    remove(AbortSignal, "timeout");
    remove(Promise, "withResolvers");
    remove(HTMLElement.prototype, "inert");
    remove(document, "startViewTransition");
    remove(Document.prototype, "startViewTransition");
    remove(window, "ScrollTimeline");
    remove(window, "ViewTimeline");
    for (const key of ["CompressionStream", "DecompressionStream"]) {
      const Native = window[key];
      if (mode === "missing") remove(window, key);
      else
        window[key] = class extends Native {
          constructor(format) {
            if (format === "deflate-raw")
              throw new TypeError("Legacy format unsupported");
            super(format);
          }
        };
    }
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      if (options?.easing?.startsWith("linear("))
        throw new TypeError("Legacy linear() easing unsupported");
      return animate.call(this, frames, options);
    };
    window.__legacyMode = mode;
  }, compression);
}
