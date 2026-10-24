import { extensionEnvironment } from "./storage";
import { ANDROID } from "./build";
import { nativeCall } from "../platform/native";
export function hash(value: string) {
  let h = 0;
  for (const c of value) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return h >>> 0;
}
export const faviconUrl = (url: string) =>
  !ANDROID && extensionEnvironment()
    ? chrome.runtime.getURL(
        `_favicon/?pageUrl=${encodeURIComponent(url)}&size=64`,
      )
    : "";
const cache = new Map<string, Promise<string | null>>();
function pixels(url: string): Promise<string | null> {
  if (typeof Image === "undefined")
    return (async () => {
      try {
        const image = await createImageBitmap(await (await fetch(url)).blob()),
          canvas = new OffscreenCanvas(32, 32),
          ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0, 32, 32);
        image.close();
        return Array.from(ctx.getImageData(0, 0, 32, 32).data).join(",");
      } catch {
        return null;
      }
    })();
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, 32, 32);
        resolve(Array.from(ctx.getImageData(0, 0, 32, 32).data).join(","));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
let globe: Promise<string | null> | undefined;
export function recognizableFavicon(url: string): Promise<string | null> {
  if (ANDROID) {
    const cached = nativeCall("favicon", url);
    return Promise.resolve(
      cached && /^data:image\/(png|webp);base64,/.test(cached) ? cached : null,
    );
  }
  if (!extensionEnvironment()) return Promise.resolve(null);
  if (!globe)
    globe = pixels(faviconUrl("https://kongjing-nonexistent.invalid"));
  if (!cache.has(url))
    cache.set(
      url,
      (async () => {
        const [fallback, icon] = await Promise.all([
          globe,
          pixels(faviconUrl(url)),
        ]);
        return icon && icon !== fallback ? faviconUrl(url) : null;
      })(),
    );
  return cache.get(url)!;
}
