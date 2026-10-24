import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaults } from "../src/lib/model";
const values = new Map<string, unknown>();
vi.mock("../src/lib/storage", () => ({
  storage: { get: async (k: string) => values.get(k) },
}));
import {
  mergeSnapshots,
  normalizeSnapshot,
  snapshotForSharing,
} from "../src/features/continuity/snapshot";
import type { ExtendedSettings } from "../src/features/continuity/service";
const ref = { blobId: "blob-1", size: 80, mime: "image/webp", w: 16, h: 16 };
beforeEach(() => values.clear());
describe("continuity snapshot adapter", () => {
  it("encodes the protocol image reference and restores the existing local model", async () => {
    const data = defaults();
    Object.assign(data.settings, {
      background: "image",
      imageUrl: "local",
      backgroundImage: ref,
    });
    const wire = await snapshotForSharing(data);
    expect(wire.settings.background).toEqual({ mode: "image", image: ref });
    expect((wire.settings as ExtendedSettings).backgroundImage).toBeUndefined();
    expect(normalizeSnapshot(wire)).toEqual(data);
    expect(data.settings.background).toBe("image");
  });
  it("keeps 2.0.1 snapshots compatible and merges images with the settings timestamp", async () => {
    const old = defaults(),
      next = structuredClone(old);
    Object.assign(next.settings, {
      updatedAt: old.settings.updatedAt + 1,
      background: "image",
      imageUrl: "local",
      backgroundImage: ref,
    });
    expect(normalizeSnapshot(old)).toEqual(old);
    const merged = normalizeSnapshot(
      mergeSnapshots(old, await snapshotForSharing(next)),
    );
    expect((merged.settings as ExtendedSettings).backgroundImage).toEqual(ref);
  });
  it("never uploads disabled local profile or background image data", async () => {
    values.set("continuity-options", { profile: false, background: false });
    const data = defaults();
    data.profile.nickname = "本机昵称";
    Object.assign(data.settings, { backgroundImage: ref });
    const wire = await snapshotForSharing(data);
    expect(wire.profile).toEqual({ nickname: "", updatedAt: 0 });
    expect((wire.settings as ExtendedSettings).backgroundImage).toBeUndefined();
    expect(data.profile.nickname).toBe("本机昵称");
  });
});
