import postcss from "postcss";
// Android-only transform before Lightning CSS. Mixing a single color with
// transparent retains its RGB channels and multiplies alpha by the percentage.
export const accentRGB = {
  dark: {
    sky: [125, 176, 255],
    mist: [94, 220, 203],
    dusk: [255, 176, 138],
    nebula: [182, 164, 255],
    sakura: [255, 158, 192],
  },
  light: {
    sky: [47, 108, 235],
    mist: [15, 159, 143],
    dusk: [227, 103, 46],
    nebula: [110, 86, 240],
    sakura: [222, 74, 126],
  },
};
export function androidCss(code: string, id: string) {
  code = code
    .replace(
      /color-mix\(in oklab, var\(--accent\) 16%, transparent\)/g,
      "rgba(125,176,255,.16)",
    )
    .replace(
      /color-mix\(in srgb, var\(--accent\) 12%, transparent\)/g,
      "var(--accent-glow)",
    )
    .replace(/100[dsl]vh/g, "var(--kj-viewport-height, 100vh)")
    .replace(/overflow-x:\s*clip/g, "overflow-x: hidden");
  const root = postcss.parse(code);
  // Lightning CSS merges the two spellings as one property and keeps the last
  // prefix. Chrome 87 uses the standard spelling; removing the redundant
  // WebKit declaration prevents it from accidentally replacing the standard.
  root.walkDecls("-webkit-backdrop-filter", (declaration) => {
    if (
      declaration.parent?.nodes.some(
        (n) => n.type === "decl" && n.prop === "backdrop-filter",
      )
    )
      declaration.remove();
  });
  root.walkDecls(/^scrollbar-(width|color)$/, (declaration) => {
    const rule = declaration.parent;
    if (rule?.type !== "rule") return;
    const selector = (suffix: string) =>
      rule.selectors.map((s) => s + suffix).join(",");
    if (declaration.prop === "scrollbar-width") {
      root.append(
        postcss.rule({
          selector: selector("::-webkit-scrollbar"),
          nodes: [
            postcss.decl({
              prop: declaration.value === "none" ? "display" : "width",
              value: declaration.value === "none" ? "none" : "var(--s-2)",
            }),
          ],
        }),
      );
    } else {
      // The existing declaration is exactly `var(--border) transparent`.
      root.append(
        postcss.rule({
          selector: selector("::-webkit-scrollbar-thumb"),
          nodes: [postcss.decl({ prop: "background", value: "var(--border)" })],
        }),
      );
      root.append(
        postcss.rule({
          selector: selector("::-webkit-scrollbar-track"),
          nodes: [postcss.decl({ prop: "background", value: "transparent" })],
        }),
      );
    }
    declaration.remove();
  });
  code = root.toString();
  if (id.replaceAll("\\", "/").endsWith("/tokens.css")) {
    code += `\n@property --accent-soft { syntax: '<color>'; inherits: true; initial-value: rgba(125,176,255,.16); }
@property --accent-glow { syntax: '<color>'; inherits: true; initial-value: rgba(125,176,255,.12); }
:root { --accent-glow: rgba(125,176,255,.12); transition: --accent 600ms var(--ease-out), --accent-soft 600ms var(--ease-out), --accent-glow 600ms var(--ease-out); }\n`;
    for (const [theme, accents] of Object.entries(accentRGB))
      for (const [name, rgb] of Object.entries(accents))
        code += `[data-theme="${theme}"]${name === "sky" ? "" : `[data-accent="${name}"]`} { --accent-soft: rgba(${rgb.join(",")},.16); --accent-glow: rgba(${rgb.join(",")},.12); }\n`;
  }
  return code;
}
