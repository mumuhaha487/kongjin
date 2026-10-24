export function searchPlaceholder(
  engineName: string,
  engineId?: string,
): string {
  const name = engineName.trim();
  if (engineId === "default") return "搜索";
  const before = /^[\p{Script=Latin}0-9]/u.test(name) ? " " : "";
  const after = /[\p{Script=Latin}0-9]$/u.test(name) ? " " : "";
  return `在${before}${name}${after}中搜索`;
}
