interface NamedDevice {
  deviceId: string;
  name: string;
}
const shortName = (name: string) => name.split(" · ", 1)[0];
/** Ambiguous prefixes retain the complete name; truncate only unambiguous short names. */
export function compactDeviceName(
  id: string,
  devices: readonly NamedDevice[],
): string {
  const device = devices.find((d) => d.deviceId === id);
  if (!device) return id;
  const short = shortName(device.name);
  if (devices.some((d) => d.deviceId !== id && shortName(d.name) === short))
    return device.name;
  const chars = Array.from(short);
  return chars.length > 12 ? chars.slice(0, 12).join("") + "…" : short;
}

/** Prefixes keep device order and reserve room for the overflow pill. */
export function fittingPills(
  widths: readonly number[],
  available: number,
  moreWidth: number,
  gap = 8,
): number {
  let used = 0,
    count = 0;
  for (const width of widths.slice(0, 4)) {
    const next = used + (count ? gap : 0) + width;
    const overflow = count + 1 < widths.length;
    if (next + (overflow ? gap + moreWidth : 0) > available) break;
    used = next;
    count++;
  }
  return count;
}
