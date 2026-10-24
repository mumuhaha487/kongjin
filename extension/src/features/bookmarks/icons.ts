import { recognizableFavicon } from "../../lib/favicon";
import { compressImage, blobDataUrl, imageTone } from "../../lib/images";
import { extensionEnvironment } from "../../lib/storage";
import type { AppData, BookmarkIcon } from "../../lib/model";
import { STORE, ANDROID } from "../../lib/build";
export interface IconDependencies {
  cached: (url: string) => Promise<string | null>;
  permission: () => Promise<boolean>;
  fetch: typeof fetch;
  normalize: (blob: Blob) => Promise<string>;
}
async function dataUrl(blob: Blob) {
  const b = await compressImage(blob, "icon");
  if (typeof FileReader !== "undefined") return blobDataUrl(b);
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (const c of bytes) s += String.fromCharCode(c);
  return `data:${b.type};base64,${btoa(s)}`;
}
export const defaultIconDeps: IconDependencies = {
  cached: recognizableFavicon,
  permission: async () =>
    !ANDROID &&
    !STORE &&
    extensionEnvironment() &&
    (await chrome.permissions.contains({ origins: ["<all_urls>"] })),
  fetch: (...args) => fetch(...args),
  normalize: dataUrl,
};
export async function limitedFetch(
  url: string,
  limit: number,
  request: typeof fetch = fetch,
) {
  const response = await request(url, {
    credentials: "omit",
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw Error("icon");
  if (Number(response.headers.get("content-length")) > limit)
    throw Error("icon-size");
  const reader = response.body?.getReader();
  if (!reader) throw Error("icon");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error("icon-size");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return new Blob([out], {
    type: response.headers.get("content-type") || "application/octet-stream",
  });
}
export function iconCandidates(html: string, page: string): string[] {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  const found = tags.flatMap((tag) => {
    const attr = (name: string) =>
      new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1] ||
      "";
    const rel = attr("rel").toLowerCase(),
      href = attr("href");
    if (!/(^|\s)(apple-touch-icon|icon|shortcut)(\s|$)/.test(rel) || !href)
      return [];
    try {
      const u = new URL(href, page);
      if (!["http:", "https:"].includes(u.protocol)) return [];
      const sizes = attr("sizes");
      return [
        {
          url: u.href,
          priority: rel.includes("apple-touch-icon")
            ? 0
            : /(\d+)x\d+/.test(sizes) && Number(RegExp.$1) >= 64
              ? 1
              : /svg/i.test(attr("type") + href)
                ? 2
                : 3,
        },
      ];
    } catch {
      return [];
    }
  });
  return [
    ...new Set([
      ...found.sort((a, b) => a.priority - b.priority).map((v) => v.url),
      new URL("/favicon.ico", page).href,
    ]),
  ];
}
export async function acquireIcon(
  url: string,
  relay = STORE ? "https://kongjing.inc.re" : "https://kongjing.inc.re",
  first?: string,
  deps = defaultIconDeps,
): Promise<BookmarkIcon> {
  const finish = async (src: string) => {
    const dataUrl = await deps.normalize(
      await limitedFetch(src, 256 * 1024, deps.fetch),
    );
    let tone: BookmarkIcon["tone"];
    try {
      tone = await imageTone(await (await fetch(dataUrl)).blob());
    } catch {
      /* keep source when a decoder is unavailable */
    }
    return { mode: "auto" as const, dataUrl, tone, fetchedAt: Date.now() };
  };
  if (
    first &&
    (ANDROID
      ? /^data:image\/(?:png|webp);base64,/.test(first)
      : !STORE || /^(?:data:|chrome-extension:)/.test(first))
  )
    try {
      return await finish(first);
    } catch {
      /* cached source */
    }
  try {
    const cached = await deps.cached(url);
    if (cached) return await finish(cached);
  } catch {
    /* next source */
  }
  if (!ANDROID && !STORE && (await deps.permission()))
    try {
      const html = await (
        await limitedFetch(url, 512 * 1024, deps.fetch)
      ).text();
      for (const candidate of iconCandidates(html, url))
        try {
          return await finish(candidate);
        } catch {
          /* next candidate */
        }
    } catch {
      /* relay */
    }
  try {
    return await finish(
      `${relay.replace(/\/$/, "")}/${!STORE && relay !== "https://kongjing.inc.re" && !/:8790$/.test(relay) ? "v2" : "v1"}/icon?host=${encodeURIComponent(new URL(url).hostname)}`,
    );
  } catch {
    return { mode: "auto", failedAt: Date.now() };
  }
}
export async function fillMissingIcons(
  load: () => AppData,
  save: (id: string, icon: BookmarkIcon) => void,
  relay?: string,
  force = false,
) {
  await fillMissingTones(load, save);
  const queue = load().bookmarks.filter(
    (b) =>
      b.icon.mode === "auto" &&
      (force ||
        (!b.icon.dataUrl &&
          (!b.icon.failedAt || Date.now() - b.icon.failedAt >= 7 * 86400000))),
  );
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const b = queue.shift()!;
        const icon = await acquireIcon(b.url, relay);
        const current = load().bookmarks.find((x) => x.id === b.id);
        if (
          current?.url === b.url &&
          current.icon.mode === "auto" &&
          (force || !current.icon.dataUrl)
        )
          save(b.id, icon);
      }
    }),
  );
}
export async function fillMissingTones(
  load: () => AppData,
  save: (id: string, icon: BookmarkIcon) => void,
) {
  const queue = load().bookmarks.filter((b) => b.icon.dataUrl && !b.icon.tone);
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const b = queue.shift()!;
        try {
          const tone = await imageTone(
            await (await fetch(b.icon.dataUrl!)).blob(),
          );
          const current = load().bookmarks.find((x) => x.id === b.id);
          if (
            current &&
            current.icon.dataUrl === b.icon.dataUrl &&
            !current.icon.tone
          )
            save(b.id, { ...current.icon, tone });
        } catch {
          /* invalid legacy image retains letter fallback */
        }
      }
    }),
  );
}
