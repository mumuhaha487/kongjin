import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { deriveGroup, unb64, b64url, deriveSlotId, sealJournal, openJournal, sealSlot, openSlot, bytesEnvelope, sealBlob, openBlob, historyEntryId } from "../src/index.ts";
const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

it("matches fixed slot HKDF, compressed journal, slot and binary blob vectors", async () => {
  const v = vectors.continuity, g = vectors.group, keys = await deriveGroup(unb64(g.gk), g.epoch), iv = unb64(v.iv);
  expect(await deriveSlotId(unb64(g.gk), g.epoch, v.deviceId)).toBe(v.slotId);
  expect(await sealJournal(keys.encKey, g.roomId, v.recordId, v.journal.plain, iv)).toEqual(v.journal.env);
  expect(await openJournal(keys.encKey, g.roomId, v.recordId, v.journal.env)).toEqual(v.journal.plain);
  expect(bytesEnvelope(await sealSlot(keys.encKey, g.roomId, v.slotId, v.slot.plain, iv))).toEqual(v.slot.env);
  expect(await openSlot(keys.encKey, g.roomId, v.slotId, v.slot.env)).toEqual(v.slot.plain);
  expect(b64url(await sealBlob(keys.encKey, g.roomId, v.recordId, unb64(v.blob.plain), iv))).toBe(v.blob.sealed);
  expect(b64url(await openBlob(keys.encKey, g.roomId, v.recordId, unb64(v.blob.sealed)))).toBe(v.blob.plain);
});
it("authenticates each channel, room and object id; uses unique random IVs", async () => {
  const v = vectors.continuity, g = vectors.group, keys = await deriveGroup(unb64(g.gk), 1);
  await expect(openJournal(keys.encKey, g.roomId + "x", v.recordId, v.journal.env)).rejects.toThrow();
  await expect(openJournal(keys.encKey, g.roomId, "wrong", v.journal.env)).rejects.toThrow();
  await expect(openSlot(keys.encKey, g.roomId, v.recordId, v.journal.env)).rejects.toThrow();
  await expect(openBlob(keys.encKey, g.roomId, "wrong", unb64(v.blob.sealed))).rejects.toThrow();
  const a = await sealJournal(keys.encKey, g.roomId, v.recordId, v.journal.plain);
  const b = await sealJournal(keys.encKey, g.roomId, v.recordId, v.journal.plain);
  expect(a.iv).not.toBe(b.iv);
});
it("deduplicates visits only within the same device, URL and minute", async () => {
  expect(await historyEntryId("A", "https://example.com", 60001)).toBe(await historyEntryId("A", "https://example.com", 119999));
  expect(await historyEntryId("B", "https://example.com", 60001)).not.toBe(await historyEntryId("A", "https://example.com", 60001));
  expect(await historyEntryId("A", "https://example.com", 120000)).not.toBe(await historyEntryId("A", "https://example.com", 60001));
});
