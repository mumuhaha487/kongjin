import type { AppData } from "../../lib/model";
import { storage } from "../../lib/storage";
import { continuityDefaults, type ContinuityOptions } from "./types";
import type { ExtendedSettings } from "./service";
import { merge } from "../../lib/merge";
export function normalizeSnapshot(input: AppData): AppData {
  const data = structuredClone(input);
  const value = data.settings.background as unknown;
  if (value && typeof value === "object") {
    const background = value as {
      mode?: string;
      image?: ExtendedSettings["backgroundImage"];
    };
    data.settings.background = ["kongjing", "solid", "image"].includes(
      background.mode || "",
    )
      ? (background.mode as AppData["settings"]["background"])
      : background.image
        ? "image"
        : "kongjing";
    if (background.image)
      (data.settings as ExtendedSettings).backgroundImage = background.image;
  }
  return data;
}
function encodeSnapshot(input: AppData) {
  const data = structuredClone(input),
    settings = data.settings as ExtendedSettings;
  if (settings.backgroundImage) {
    const reference = settings.backgroundImage;
    delete settings.backgroundImage;
    Object.assign(settings, {
      background: { mode: settings.background, image: reference },
    });
  }
  return data;
}
export function mergeSnapshots(a: AppData, b: AppData) {
  return encodeSnapshot(merge(normalizeSnapshot(a), normalizeSnapshot(b)));
}
export async function snapshotForSharing(data: AppData) {
  const options = {
    ...continuityDefaults,
    ...(await storage.get<ContinuityOptions>("continuity-options")),
  };
  if (options.profile && options.background) return encodeSnapshot(data);
  const snapshot = structuredClone(data);
  if (!options.profile) snapshot.profile = { nickname: "", updatedAt: 0 };
  if (!options.background)
    delete (snapshot.settings as ExtendedSettings).backgroundImage;
  return encodeSnapshot(snapshot);
}
