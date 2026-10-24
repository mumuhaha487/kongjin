import { deflateSync, Inflate, strToU8, strFromU8 } from "fflate";
import { migrate } from "./migration";
import { cleanSettings, type AppData } from "./model";
export const backupLimit = 5 * 1024 * 1024;
const damaged = "导入码不完整或已损坏";
const invalid = "不是空境的导入码或备份文件";
export function base64url(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function bytes(s: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw Error(damaged);
  try {
    return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw Error(damaged);
  }
}
const buffer = (a: Uint8Array) => a.slice().buffer as ArrayBuffer;
async function key(pass: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey(
    "raw",
    buffer(strToU8(pass)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: buffer(salt), iterations: 310000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export function backupObject(data: AppData, background?: string) {
  return {
    format: "kongjing-backup",
    version: 2,
    exportedAt: Date.now(),
    data: { ...data, settings: cleanSettings(data.settings) },
    ...(background ? { background } : {}),
  };
}
async function checksum(a: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(a))),
    (x) => x.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 8);
}
export async function encodeBackup(data: AppData, pass = "") {
  const packed = deflateSync(strToU8(JSON.stringify(backupObject(data))));
  if (!pass) return `KJ2.${base64url(packed)}.${await checksum(packed)}`;
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await key(pass, salt),
      buffer(packed),
    ),
  );
  const all = new Uint8Array(28 + encrypted.length);
  all.set(salt);
  all.set(iv, 16);
  all.set(encrypted, 28);
  return `KJ2E.${base64url(all)}`;
}
export interface Imported {
  data: AppData;
  background?: string;
}
export async function decodeBackup(
  input: string,
  pass = "",
): Promise<Imported> {
  if (new TextEncoder().encode(input).length > backupLimit)
    throw Error("导入内容需小于 5 MB");
  const text = input.trim();
  let json = text;
  if (text.startsWith("KJ2.")) {
    const parts = text.split(".");
    if (parts.length !== 3) throw Error(damaged);
    const a = bytes(parts[1]);
    if ((await checksum(a)) !== parts[2]) throw Error(damaged);
    json = unpack(a);
  } else if (text.startsWith("KJ2E.")) {
    const a = bytes(text.slice(5));
    if (a.length < 45) throw Error(damaged);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buffer(a.subarray(16, 28)) },
        await key(pass, a.subarray(0, 16)),
        buffer(a.subarray(28)),
      );
    } catch {
      throw Error("口令不正确");
    }
    json = unpack(new Uint8Array(plain));
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw Error(invalid);
  }
  const obj = value as Record<string, unknown>;
  const data = migrate(obj?.format === "kongjing-backup" ? obj.data : value);
  if (!data) throw Error(invalid);
  const background =
    typeof obj.background === "string" &&
    /^data:image\/(png|jpeg|webp|gif);base64,/.test(obj.background)
      ? obj.background
      : undefined;
  return { data, background };
}
function unpack(a: Uint8Array) {
  try {
    let length = 0;
    const chunks: Uint8Array[] = [];
    const stream = new Inflate((chunk) => {
      length += chunk.length;
      if (length > backupLimit) throw Error(damaged);
      chunks.push(chunk);
    });
    for (let i = 0; i < a.length; i += 256)
      stream.push(a.subarray(i, i + 256), i + 256 >= a.length);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const c of chunks) {
      output.set(c, offset);
      offset += c.length;
    }
    return strFromU8(output);
  } catch {
    throw Error(damaged);
  }
}
export function backupFilename(now = new Date()) {
  const z = (n: number) => String(n).padStart(2, "0");
  return `空境备份-${now.getFullYear()}${z(now.getMonth() + 1)}${z(now.getDate())}-${z(now.getHours())}${z(now.getMinutes())}.json`;
}
