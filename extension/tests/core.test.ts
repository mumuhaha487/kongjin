import { describe, it, expect } from "vitest";
import { defaults } from "../src/lib/model";
import { merge } from "../src/lib/merge";
import { migrate } from "../src/lib/migration";
import {
  validateData,
  normalizeUrl,
  isAddress,
  autoTitle,
} from "../src/lib/validation";
import {
  encodeBackup,
  decodeBackup,
  backupObject,
  backupLimit,
} from "../src/lib/backup";
import {
  normalizePairCode,
  formatPairCode,
  formatSas,
  displayPairInput,
} from "../src/features/pairing/types";
import { searchPlaceholder } from "../src/features/search/placeholder";
import {
  acquireIcon,
  iconCandidates,
  fillMissingIcons,
  type IconDependencies,
} from "../src/features/bookmarks/icons";
import {
  avatarQualities,
  iconQualities,
  avatarLimit,
  iconLimit,
  pixelTone,
} from "../src/lib/images";
import { memoryStorage } from "../src/lib/storage";
import { STORE, ANDROID } from "../src/lib/build";
function legacy() {
  const d = defaults();
  return {
    ...d,
    schema: 1,
    profile: undefined,
    settings: {
      ...d.settings,
      accent: "jade",
      background: "aurora",
      nickname: "旧昵称",
    },
    bookmarks: d.bookmarks.map(({ icon: _icon, ...b }) => b),
  };
}
describe("schema migration", () => {
  it("defaults popup auto-close on for fresh installs and schema 1 upgrades", () => {
    expect(defaults().settings.autoClose).toBe(true);
    const old = legacy();
    const settings: Partial<typeof old.settings> = { ...old.settings };
    delete settings.autoClose;
    expect(migrate({ ...old, settings })!.settings.autoClose).toBe(true);
    expect(
      migrate({ ...old, settings: { ...settings, autoClose: false } })!.settings
        .autoClose,
    ).toBe(true);
    const current = defaults();
    current.settings.autoClose = false;
    expect(migrate(current)!.settings.autoClose).toBe(false);
  });
  it("preserves entities, settings, custom engines; maps accent; moves old session username", () => {
    const old = legacy();
    old.searchEngines = [
      {
        id: "custom",
        name: "test",
        url: "https://example.com/?q=%s",
        updatedAt: 1,
      },
    ];
    const d = migrate(
      { ...old, session: { token: "never-persist" }, server: "legacy" },
      "Alex",
    )!;
    expect(d.schema).toBe(2);
    expect(d.profile.nickname).toBe("Alex");
    expect(d.settings.accent).toBe("mist");
    expect(d.settings.background).toBe("kongjing");
    expect(d.bookmarks.length).toBe(6);
    expect(d.bookmarks[0].icon).toEqual({ mode: "auto" });
    expect(d).not.toHaveProperty("session");
    expect(d).not.toHaveProperty("server");
    expect(d.settings).not.toHaveProperty("nickname");
    expect(d.searchEngines).toEqual(old.searchEngines);
  });
  it("is idempotent", () => {
    const d = migrate(legacy())!;
    expect(migrate(d)).toEqual(d);
  });
  it("rejects malformed and unsafe imports", () => {
    expect(migrate({ schema: 1 })).toBe(null);
    const d = defaults();
    d.bookmarks[0].url = "javascript:alert(1)";
    expect(validateData(d)).toBe(false);
    const empty = defaults();
    empty.groups = [];
    expect(validateData(empty)).toBe(false);
  });
});
describe("v2 merge", () => {
  it("is commutative, deterministic, and idempotent for timestamp ties", () => {
    const a = defaults(),
      b = defaults();
    a.profile = { nickname: "A", updatedAt: 20 };
    b.profile = { nickname: "B", updatedAt: 20 };
    a.bookmarks[0].icon = {
      mode: "custom",
      url: "https://example.com/icon.png",
    };
    a.bookmarks[0].updatedAt = 10;
    expect(merge(a, b)).toEqual(merge(b, a));
    expect(merge(a, a)).toEqual(a);
    expect(
      merge(a, b).bookmarks.find((b) => b.id === "default-github")?.icon.mode,
    ).toBe("custom");
  });
  it("profile last write wins", () => {
    const a = defaults(),
      b = defaults();
    b.profile = { nickname: "new", updatedAt: 1 };
    expect(merge(a, b).profile.nickname).toBe("new");
  });
  it("tombstone wins equal timestamp and prunes after 90 days", () => {
    const a = defaults(),
      b = defaults();
    b.tombstones = [
      { id: a.bookmarks[0].id, kind: "bookmark", deletedAt: 100 },
    ];
    expect(merge(a, b, 100).bookmarks.length).toBe(5);
    expect(merge(a, b, 100 + 91 * 86400000).tombstones).toEqual([]);
  });
  it("orphan bookmarks move to a surviving group", () => {
    const a = defaults(),
      b = defaults();
    a.groups.push({ id: "x", name: "X", order: 1, updatedAt: 1 });
    a.bookmarks[0].groupId = "x";
    a.bookmarks[0].updatedAt = 5;
    b.tombstones.push({ id: "x", kind: "group", deletedAt: 10 });
    expect(
      merge(a, b, 10).bookmarks.find((b) => b.id === a.bookmarks[0].id)
        ?.groupId,
    ).toBe("default-common");
  });
});
describe("backup codecs", () => {
  it("JSON envelope and v1 import", async () => {
    const data = defaults();
    expect(
      (await decodeBackup(JSON.stringify(backupObject(data)))).data,
    ).toEqual(data);
    expect((await decodeBackup(JSON.stringify(legacy()))).data.schema).toBe(2);
  });
  it("KJ2 roundtrip, checksum tamper and truncation", async () => {
    const d = defaults(),
      code = await encodeBackup(d);
    expect(code.startsWith("KJ2.")).toBe(true);
    expect((await decodeBackup(code)).data).toEqual(d);
    await expect(decodeBackup(code.slice(0, -2))).rejects.toThrow(
      "导入码不完整或已损坏",
    );
  });
  it("KJ2E random salt/iv, decrypt and wrong passphrase", async () => {
    const a = await encodeBackup(defaults(), "test passphrase"),
      b = await encodeBackup(defaults(), "test passphrase");
    expect(a).not.toBe(b);
    expect((await decodeBackup(a, "test passphrase")).data).toEqual(defaults());
    await expect(decodeBackup(a, "wrong")).rejects.toThrow("口令不正确");
  });
  it("size and invalid format errors", async () => {
    await expect(decodeBackup("x".repeat(backupLimit + 1))).rejects.toThrow(
      "5 MB",
    );
    await expect(decodeBackup("garbage")).rejects.toThrow("不是空境");
    await expect(decodeBackup("KJ2.???..b")).rejects.toThrow(
      "导入码不完整或已损坏",
    );
  });
});
describe("formatting", () => {
  it.each([
    ["必应", "在必应中搜索"],
    ["Google", "在 Google 中搜索"],
    ["DuckDuckGo", "在 DuckDuckGo 中搜索"],
    ["自定义", "在自定义中搜索"],
    ["Google搜索", "在 Google搜索中搜索"],
    ["搜索Google", "在搜索Google 中搜索"],
    ["123", "在 123 中搜索"],
    ["Écosia", "在 Écosia 中搜索"],
    [" 百度 ", "在百度中搜索"],
  ])("placeholder %s", (name, result) =>
    expect(searchPlaceholder(name)).toBe(result),
  );
  it("normalizes URLs and distinguishes search text", () => {
    expect(normalizeUrl("github.com")).toBe("https://github.com/");
    expect(isAddress("hello world.com")).toBe(false);
    expect(normalizeUrl("javascript:alert(1)")).toBe(null);
    expect(autoTitle("https://www.github.com/a")).toBe("Github");
  });
  it("pair code aliases and SAS", () => {
    expect(normalizePairCode("kj-oIl23-abcd4")).toBe("01123ABCD4");
    expect(formatPairCode("8f3qzt7m2c")).toBe("KJ-8F3QZ-T7M2C");
    expect(normalizePairCode("invalid")).toBe(null);
    expect(displayPairInput("8f3qzt7")).toBe("KJ-8F3QZ-T7");
    expect(formatSas("913")).toBe("000 913");
  });
});
describe("icon acquisition", () => {
  const mock = (source: "cache" | "direct" | "relay" | "fallback") => {
    const calls: string[] = [];
    const deps: IconDependencies = {
      cached: async () => (source === "cache" ? "https://cache/icon" : null),
      permission: async () => source === "direct",
      fetch: async (input) => {
        const u = String(input);
        calls.push(u);
        if (source === "fallback") return new Response(null, { status: 404 });
        if (u === "https://example.com/")
          return new Response(
            '<link rel="apple-touch-icon" href="/apple.png">',
          );
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      },
      normalize: async () => "data:image/webp;base64,AQID",
    };
    return { deps, calls };
  };
  it.each(["cache", "direct", "relay", "fallback"] as const)(
    "source %s",
    async (source) => {
      const { deps, calls } = mock(source);
      const icon = await acquireIcon(
        "https://example.com/",
        "https://relay.test",
        undefined,
        deps,
      );
      expect(!!icon.dataUrl).toBe(source !== "fallback");
      if (source === "cache") expect(calls).toEqual(["https://cache/icon"]);
      if (source === "direct") {
        if (STORE || ANDROID)
          expect(calls).toEqual([
            `https://relay.test/${STORE ? "v1" : "v2"}/icon?host=example.com`,
          ]);
        else expect(calls[1]).toBe("https://example.com/apple.png");
      }
      if (source === "relay")
        expect(calls[0]).toContain(`/${STORE ? "v1" : "v2"}/icon?host=example.com`);
      if (source === "fallback") expect(icon.failedAt).toBeGreaterThan(0);
    },
  );
  it("prioritizes apple then >=64 then SVG", () => {
    const html =
      '<link rel="icon" href="/x.ico"><link rel="icon" sizes="128x128" href="/big.png"><link rel="apple-touch-icon" href="/apple.png"><link rel="icon" type="image/svg+xml" href="/vector.svg">';
    expect(
      iconCandidates(html, "https://example.com").map(
        (s) => new URL(s).pathname,
      ),
    ).toEqual([
      "/apple.png",
      "/big.png",
      "/vector.svg",
      "/x.ico",
      "/favicon.ico",
    ]);
  });
  it("does not retry a failed icon within seven days", async () => {
    const d = defaults();
    d.bookmarks.forEach(
      (b) => (b.icon = { mode: "auto", failedAt: Date.now() }),
    );
    let calls = 0;
    await fillMissingIcons(
      () => d,
      () => calls++,
    );
    expect(calls).toBe(0);
  });
});
it("image caps and prescribed quality order", () => {
  expect(avatarLimit).toBe(8192);
  expect(iconLimit).toBe(6144);
  expect(avatarQualities).toEqual([0.85, 0.75, 0.65, 0.55, 0.45, 0.35]);
  expect(iconQualities).toEqual([0.9, 0.8, 0.6, 0.4]);
});
it("isolated storage instances", async () => {
  const a = memoryStorage(),
    b = memoryStorage();
  await a.set("data", defaults());
  expect(await b.get("data")).toBeUndefined();
});
it("classifies monochrome icons by alpha, luminance and saturation", () => {
  const pixels = (r: number, g: number, b: number, a = 255) =>
    new Uint8ClampedArray([r, g, b, a]);
  expect(pixelTone(pixels(0, 0, 0))).toBe("dark");
  expect(pixelTone(pixels(255, 255, 255))).toBe("light");
  expect(pixelTone(pixels(0, 0, 0, 127))).toBe("normal");
  expect(pixelTone(pixels(0, 0, 255))).toBe("normal");
  expect(pixelTone(pixels(160, 160, 160))).toBe("normal");
});
