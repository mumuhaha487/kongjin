import { continuityCommand } from "./bridge";
import { imageFile } from "../../lib/storage";
export async function shareBackground(file: Blob) {
  const bitmap = await createImageBitmap(file);
  let blob = file,
    w = bitmap.width,
    h = bitmap.height;
  if (file.size > 3 * 1024 * 1024 - 1024) {
    const ratio = Math.min(1, 2560 / Math.max(w, h));
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(Error("无法读取这张图片"))),
        "image/webp",
        0.86,
      ),
    );
  }
  bitmap.close();
  if (blob.size > 3 * 1024 * 1024 - 1024) throw Error("背景图片需小于 3 MB");
  await imageFile(blob);
  const base64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  return continuityCommand<import("./service").ImageReference | undefined>(
    "background",
    { base64, mime: blob.type, w, h },
  );
}
