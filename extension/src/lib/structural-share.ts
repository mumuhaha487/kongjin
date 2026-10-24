// Data updates still use a private mutable clone. Reuse unchanged branches at
// publication so narrow selectors do not rerender for an unrelated setting.
export function structuralShare<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (
    !previous ||
    !next ||
    typeof previous !== "object" ||
    typeof next !== "object"
  )
    return next;
  const a = previous as Record<string, unknown>,
    b = next as Record<string, unknown>;
  const keys = Object.keys(b);
  let equal =
    keys.length === Object.keys(a).length &&
    Array.isArray(a) === Array.isArray(b);
  for (const key of keys) {
    b[key] = structuralShare(a[key], b[key]);
    if (b[key] !== a[key]) equal = false;
  }
  return equal ? previous : next;
}
