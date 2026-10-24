import { describe, expect, it } from "vitest";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  installCompressionStreams,
  type CompressionHost,
} from "../src/platform/compat/compression";
import {
  encodeBackup,
  decodeBackup,
  backupObject,
  base64url,
} from "../src/lib/backup";
import { defaults } from "../src/lib/model";
import { androidVersion } from "../src/platform/native";
import { androidCss, accentRGB } from "../scripts/android-css";
import {
  aesKey,
  sealSnapshot,
  openSnapshot,
  deflateRaw,
} from "../../shared/protocol/src/crypto";

const input = new TextEncoder().encode(
  "空境：兼容旧 WebView、桌面与 Android。".repeat(200),
);
const native = {
  CompressionStream: globalThis.CompressionStream,
  DecompressionStream: globalThis.DecompressionStream,
};
function fallback(): Required<CompressionHost> {
  const host: CompressionHost = {};
  installCompressionStreams(host);
  return host as Required<CompressionHost>;
}
async function run(
  bytes: Uint8Array,
  stream: { readable: ReadableStream; writable: WritableStream },
) {
  return new Uint8Array(
    await new Response(
      new Blob([Uint8Array.from(bytes).buffer]).stream().pipeThrough(stream),
    ).arrayBuffer(),
  );
}
async function withFallback<T>(fn: () => Promise<T>) {
  const host = fallback();
  Object.assign(globalThis, host);
  try {
    return await fn();
  } finally {
    Object.assign(globalThis, native);
  }
}
describe("Android WebView 87 compression compatibility", () => {
  it.each(["deflate-raw", "deflate", "gzip"] as const)(
    "%s native and polyfill cross-decode in both directions",
    async (format) => {
      const poly = fallback();
      const compressed = await run(input, new poly.CompressionStream(format));
      expect(
        await run(compressed, new native.DecompressionStream(format)),
      ).toEqual(input);
      const fromNative = await run(input, new native.CompressionStream(format));
      expect(
        await run(fromNative, new poly.DecompressionStream(format)),
      ).toEqual(input);
      if (format === "deflate-raw") {
        expect(new Uint8Array(inflateRawSync(compressed))).toEqual(input);
        expect(
          await run(
            deflateRawSync(input),
            new poly.DecompressionStream(format),
          ),
        ).toEqual(input);
      }
    },
  );
  it("uses native formats when only deflate-raw is unsupported", async () => {
    let delegates = 0;
    class Limited extends native.CompressionStream {
      constructor(format: CompressionFormat) {
        if (format === "deflate-raw") throw new TypeError("Old browser");
        delegates++;
        super(format);
      }
    }
    const host = {
      CompressionStream: Limited,
      DecompressionStream: native.DecompressionStream,
    };
    installCompressionStreams(host);
    await run(input, new host.CompressionStream("deflate"));
    expect(delegates).toBe(1);
    expect(
      new Uint8Array(
        inflateRawSync(
          await run(input, new host.CompressionStream("deflate-raw")),
        ),
      ),
    ).toEqual(input);
    expect(host.DecompressionStream).toBe(native.DecompressionStream);
  });
  it("streams split BufferSources and rejects corrupt data/unsupported format", async () => {
    const poly = fallback();
    const chunks = new ReadableStream<BufferSource>({
      start(c) {
        for (let i = 0; i < input.length; i += 113)
          c.enqueue(input.subarray(i, i + 113));
        c.close();
      },
    });
    const compressed = new Uint8Array(
      await new Response(
        chunks.pipeThrough(new poly.CompressionStream("deflate-raw")),
      ).arrayBuffer(),
    );
    expect(
      await run(compressed, new native.DecompressionStream("deflate-raw")),
    ).toEqual(input);
    expect(
      () => new poly.CompressionStream("bad" as CompressionFormat),
    ).toThrow(TypeError);
    await expect(
      run(
        new Uint8Array([255, 255]),
        new poly.DecompressionStream("deflate-raw"),
      ),
    ).rejects.toBeDefined();
  });
  it("shared snapshot fallback interoperates with native and protocol decoder", async () => {
    const key = await aesKey(crypto.getRandomValues(new Uint8Array(32)));
    const plain = {
      v: 1 as const,
      writer: "test",
      at: 1,
      data: defaults(),
      group: { members: [], epoch: 1 },
    };
    const nativeSnapshot = await sealSnapshot(key, "room", plain);
    await withFallback(async () => {
      expect(await openSnapshot(key, "room", nativeSnapshot)).toEqual(plain);
      const packed = await deflateRaw(input);
      expect(
        await run(packed, new native.DecompressionStream("deflate-raw")),
      ).toEqual(input);
    });
    const fallbackSnapshot = await withFallback(() =>
      sealSnapshot(key, "room", plain),
    );
    expect(await openSnapshot(key, "room", fallbackSnapshot)).toEqual(plain);
  });
  it("same native-compressed KJ2 code parses with and without the polyfill; KJ2E roundtrip", async () => {
    const data = defaults(),
      json = new TextEncoder().encode(JSON.stringify(backupObject(data)));
    const packed = await run(json, new native.CompressionStream("deflate-raw"));
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", packed.slice().buffer),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    )
      .join("")
      .slice(0, 8);
    const code = `KJ2.${base64url(packed)}.${hash}`;
    expect((await decodeBackup(code)).data).toEqual(data);
    expect((await withFallback(() => decodeBackup(code))).data).toEqual(data);
    const encrypted = await withFallback(() =>
      encodeBackup(data, "test passphrase"),
    );
    expect((await decodeBackup(encrypted, "test passphrase")).data).toEqual(
      data,
    );
  });
});
describe("Android-only presentation adaptation", () => {
  it("precomputes exact rgba endpoints for both themes and all accents", () => {
    const css = androidCss(
      "--accent-soft: color-mix(in oklab, var(--accent) 16%, transparent)",
      "/styles/tokens.css",
    );
    expect(css).not.toContain("color-mix(");
    for (const accents of Object.values(accentRGB))
      for (const rgb of Object.values(accents))
        expect(css).toContain(`rgba(${rgb.join(",")},.16)`);
    expect(
      androidCss("max-height:100dvh;overflow-x: clip", "android.css"),
    ).toContain("var(--kj-viewport-height, 100vh)");
    const scroll = androidCss(
      ".x { scrollbar-width: none; } .y { scrollbar-width: thin; scrollbar-color:var(--border) transparent; }",
      "/app.css",
    );
    expect(scroll).not.toContain("scrollbar-width:");
    expect(scroll).toContain(".x::-webkit-scrollbar");
    expect(scroll).toContain("var(--s-2)");
    expect(scroll).toContain(".y::-webkit-scrollbar-thumb");
    const glass = androidCss(
      ".glass {backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px)}",
      "/app.css",
    );
    expect(glass).toContain("backdrop-filter:blur(28px)");
    expect(glass).not.toContain("-webkit-backdrop-filter");
  });
  it("about version uses native appVersion and gracefully falls back", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { KongjingNative: { appVersion: () => "1.0.1" } },
      });
      expect(androidVersion("2.0.1")).toBe("空境 安卓版 1.0.1 · 主页 2.0.1");
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {},
      });
      expect(androidVersion("2.0.1")).toBe("主页 2.0.1");
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
