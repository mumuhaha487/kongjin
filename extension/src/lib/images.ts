export const iconLimit = 6 * 1024,
  avatarLimit = 8 * 1024;
export const avatarQualities = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];
export const iconQualities = [0.9, 0.8, 0.6, 0.4];
export type IconTone = "dark" | "light" | "normal";
export function pixelTone(pixels: Uint8ClampedArray): IconTone {
  let luminance = 0,
    saturation = 0,
    count = 0;
  const linear = (v: number) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] <= 127.5) continue;
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]].map(
      (v) => v / 255,
    );
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b),
      l = (max + min) / 2;
    luminance += 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    saturation += max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    count++;
  }
  if (!count) return "normal";
  return saturation / count < 0.18
    ? luminance / count < 0.22
      ? "dark"
      : luminance / count > 0.85
        ? "light"
        : "normal"
    : "normal";
}
export async function imageTone(blob: Blob): Promise<IconTone> {
  const image = await decode(blob);
  try {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(64, 64)
        : Object.assign(document.createElement("canvas"), {
            width: 64,
            height: 64,
          });
    const ctx = canvas.getContext("2d") as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D;
    ctx.drawImage(image, 0, 0, 64, 64);
    return pixelTone(ctx.getImageData(0, 0, 64, 64).data);
  } finally {
    if ("close" in image) image.close();
  }
}
export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(Error("无法读取这张图片"));
    r.readAsDataURL(blob);
  });
}
async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (!/svg|icon|ico/.test(blob.type))
    try {
      return await createImageBitmap(blob);
    } catch {
      /* img fallback */
    }
  if (typeof Image === "undefined") throw Error("无法读取这张图片");
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(Error("无法读取这张图片"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function encode(
  image: ImageBitmap | HTMLImageElement,
  size: number,
  quality: number,
  crop: boolean,
  type = "image/webp",
) {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement("canvas"), {
          width: size,
          height: size,
        });
  const ctx = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D;
  const w = image.width,
    h = image.height,
    scale = crop ? Math.max(size / w, size / h) : Math.min(size / w, size / h);
  ctx.drawImage(
    image,
    (size - w * scale) / 2,
    (size - h * scale) / 2,
    w * scale,
    h * scale,
  );
  if (canvas instanceof OffscreenCanvas)
    return canvas.convertToBlob({ type, quality });
  return new Promise<Blob>((res, rej) =>
    canvas.toBlob(
      (b) => (b ? res(b) : rej(Error("无法读取这张图片"))),
      type,
      quality,
    ),
  );
}
export async function compressImage(blob: Blob, kind: "avatar" | "icon") {
  const max = kind === "avatar" ? 2 * 1024 * 1024 : 512 * 1024;
  if (blob.size > max)
    throw Error(kind === "avatar" ? "图片需小于 2 MB" : "图片需小于 512 KB");
  const image = await decode(blob);
  try {
    if (kind === "avatar")
      for (const size of [96, 64])
        for (const q of avatarQualities) {
          const b = await encode(image, size, q, true);
          if (b.type === "image/webp" && b.size <= avatarLimit) return b;
        }
    if (kind === "icon") {
      for (const q of iconQualities) {
        const b = await encode(image, 64, q, false);
        if (b.type === "image/webp" && b.size <= iconLimit) return b;
      }
      const b = await encode(image, 32, 1, false, "image/png");
      if (b.size <= iconLimit) return b;
    }
    throw Error(
      kind === "avatar"
        ? "这张图片太复杂，无法压缩到 8 KB 以内，请换一张"
        : "无法读取这张图片",
    );
  } finally {
    if ("close" in image) image.close();
  }
}
