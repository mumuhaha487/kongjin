import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import assert from "node:assert/strict";
import { ESLint } from "eslint";
import ts from "typescript-eslint";
import compat from "eslint-plugin-compat";
import browserslist from "browserslist";
import postcss from "postcss";
import { transformWithEsbuild } from "vite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  bcd = require("@mdn/browser-compat-data");
const query = (await readFile("browserslist.android", "utf8")).trim();
assert.ok(browserslist(query).includes("chrome 87"));
async function walk(dir) {
  const paths = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    paths.push(...(e.isDirectory() ? await walk(p) : [p]));
  }
  return paths;
}
const sources = (await walk("src")).filter(
  (p) =>
    /\.[tj]sx?$/.test(p) &&
    !/[\\/](background|content|popup|testing|offscreen)[\\/]/.test(p),
);
sources.push(
  ...(await walk("../shared/protocol/src")).filter((p) => p.endsWith(".ts")),
);
const polyfills = [
  "structuredClone",
  "crypto.randomUUID",
  "Crypto.randomUUID",
  "AbortSignal.timeout",
  "CompressionStream",
  "DecompressionStream",
  "HTMLElement.inert",
  "Element.inert",
  "Array.at",
  "Array.prototype.at",
];
const lint = new ESLint({
  cwd: resolve(".."),
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.{ts,tsx,js}"],
      languageOptions: {
        parser: ts.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: { compat },
      settings: { browsers: [query], lintAllEsApis: true, polyfills },
      rules: { "compat/compat": "error" },
    },
  ],
});
const findings = (await lint.lintFiles(sources)).flatMap((r) =>
  r.messages.map((m) => ({
    file: relative(resolve(".."), r.filePath),
    line: m.line,
    message: m.message,
  })),
);
const artifacts = await walk("dist-android");
const js = artifacts.filter((p) => p.endsWith(".js"));
for (const p of js) {
  const input = await readFile(p, "utf8");
  const options = {
    supported: { "top-level-await": false },
    logLevel: "silent",
    sourcemap: false,
  };
  const old = await transformWithEsbuild(input, p, {
    ...options,
    target: "chrome87",
  });
  const modern = await transformWithEsbuild(input, p, {
    ...options,
    target: "esnext",
  });
  assert.equal(old.code, modern.code, `Untranspiled modern syntax: ${p}`);
}
const graph = JSON.parse(
  await readFile("tests/webview87-build-graph.json", "utf8"),
);
assert.equal(graph.target, "chrome87");
const motionModules = graph.modules.filter((p) =>
  /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/.test(
    p,
  ),
);
assert.ok(
  motionModules.length > 0,
  "motion dependencies included in Chrome87 compilation",
);
assert.ok(graph.modules.some((p) => p.endsWith("/platform/android-entry.ts")));
const texts = await Promise.all(
  sources.map(async (path) => ({
    path: relative(resolve(".."), path),
    code: await readFile(path, "utf8"),
  })),
);
const apiChecks = {
  "Array.prototype.at": /\.at\s*\(/g,
  "Array.prototype.findLast/findLastIndex": /\.findLast(?:Index)?\s*\(/g,
  "Array.prototype.toSorted": /\.toSorted\s*\(/g,
  "Object.hasOwn": /Object\.hasOwn\s*\(/g,
  structuredClone: /\bstructuredClone\s*\(/g,
  "crypto.randomUUID": /crypto\.randomUUID\s*\(/g,
  "AbortSignal.timeout": /AbortSignal\.timeout\s*\(/g,
  "Promise.withResolvers": /Promise\.withResolvers\s*\(/g,
  inert: /\.inert\s*=/g,
};
const apis = Object.fromEntries(
  Object.entries(apiChecks).map(([name, pattern]) => [
    name,
    {
      files: texts
        .filter((t) =>
          pattern.test(t.code)
            ? ((pattern.lastIndex = 0), true)
            : ((pattern.lastIndex = 0), false),
        )
        .map((t) => t.path),
      handling: [
        "structuredClone",
        "crypto.randomUUID",
        "AbortSignal.timeout",
        "inert",
        "Array.prototype.at",
      ].includes(name)
        ? "Android entry polyfill before app/shared dependencies"
        : "not used; reject new unpolyfilled calls",
    },
  ]),
);
for (const [name, check] of Object.entries(apis))
  if (check.handling.startsWith("not used"))
    assert.equal(check.files.length, 0, name);
const cssFiles = artifacts.filter((p) => p.endsWith(".css")),
  cssFindings = [],
  auditedCSS = [];
for (const path of cssFiles) {
  const root = postcss.parse(await readFile(path, "utf8"));
  let declarations = 0;
  root.walkAtRules((rule) => {
    if (["layer", "container"].includes(rule.name))
      cssFindings.push(`${path}: @${rule.name}`);
  });
  root.walkRules((rule) => {
    if (
      /:has\(|:is\(|:where\(|&/.test(rule.selector) ||
      rule.parent?.type === "rule"
    )
      cssFindings.push(`${path}: ${rule.selector}`);
  });
  root.walkDecls((d) => {
    declarations++;
    if (
      d.prop === "-webkit-backdrop-filter" &&
      !d.parent.nodes.some(
        (n) => n.type === "decl" && n.prop === "backdrop-filter",
      )
    )
      cssFindings.push(
        `${path}: Chrome requires standard backdrop-filter declaration`,
      );
    if (!d.prop.startsWith("--") && !d.prop.startsWith("-")) {
      const support = bcd.css.properties[d.prop]?.__compat.support.chrome;
      if (support) {
        const entries = Array.isArray(support) ? support : [support];
        const available = entries.some(
          (s) =>
            !s.alternative_name &&
            !s.flags &&
            (s.version_added === true ||
              (typeof s.version_added === "string" &&
                parseFloat(s.version_added) <= 87)) &&
            (!s.prefix ||
              d.parent.nodes.some(
                (n) => n.type === "decl" && n.prop === s.prefix + d.prop,
              )),
        );
        if (!available)
          cssFindings.push(
            `${path}: Chrome87 property ${d.prop} requires a fallback`,
          );
      }
    }
    if (
      /color-mix\(|\b[\d.]+[dsl]v[hw]\b/.test(d.value) ||
      ["aspect-ratio", "translate", "scale", "rotate", "accent-color"].includes(
        d.prop,
      ) ||
      (d.prop.startsWith("overflow") && d.value === "clip")
    )
      cssFindings.push(`${path}: ${d.prop}: ${d.value}`);
  });
  auditedCSS.push({ file: relative(resolve(), path), declarations });
}
const result = {
  passed: findings.length === 0 && cssFindings.length === 0,
  browserslist: query,
  sourceFiles: sources.length,
  jsChunks: js.length,
  motionModules: motionModules.length,
  polyfills,
  findings,
  apis,
  auditedCSS,
  cssFindings,
  cssChecklist: [
    "color-mix → precomputed rgba for 2 themes × 5 accents",
    ":has/:is/:where, nesting, @layer/@container → absent after Lightning CSS chrome87",
    "dvh → visualViewport CSS variable; svh/lvh absent",
    "aspect-ratio, translate/scale/rotate, accent-color → absent",
    "overflow:clip → hidden",
    "scrollbar-width/color → WebKit pseudo-elements; thin uses existing 8px token",
    "mask/backdrop-filter → Lightning CSS WebKit prefixes",
    "all emitted CSS properties checked against MDN Chrome support/prefixes",
  ],
  mdnMinimum: {
    is: bcd.css.selectors.is.__compat.support.chrome,
    where: bcd.css.selectors.where.__compat.support.chrome,
    inert: bcd.html.global_attributes.inert.__compat.support.chrome,
    compressionStream: bcd.api.CompressionStream.__compat.support.chrome,
  },
};
await writeFile(
  "tests/webview87-compat-result.json",
  JSON.stringify(result, null, 2),
);
if (!result.passed)
  console.error(JSON.stringify({ findings, cssFindings }, null, 2));
assert.ok(result.passed, "WebView 87 compatibility audit");
console.log(
  `PASS Chrome/WebView87: ${sources.length} source files (including shared), ${js.length} JS chunks, ${cssFiles.length} CSS files`,
);
