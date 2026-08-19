#!/usr/bin/env node
/**
 * Port every Tailwind UI React reference template to Astro + Preact.
 *
 * Reads  webmail/referenceTemplates/tailwindcss.com/react/**\/*.jsx
 * Writes webmail/referenceTemplates/astro/{same path}/{name}.tsx
 *        webmail/referenceTemplates/astro/{same path}/{name}.astro
 *        webmail/referenceTemplates/astro/_kit/heroicons/{24-outline,24-solid,20-solid,16-solid}.tsx
 *        webmail/referenceTemplates/astro/_kit/heroicons/props.ts
 *
 * Re-run from the repo root:
 *   node webmail/referenceTemplates/astro/_generate.mjs
 *   npx oxfmt webmail/referenceTemplates/astro   # generated output is not pre-formatted
 *   npx oxlint webmail/referenceTemplates/astro  # must be clean before committing
 *
 * That lint step is not optional politeness: the first run of this generator
 * emitted 125 icon components that could not be parsed at all, and they merged
 * because nothing in CI looked at this subtree. See `jsxExprString` below.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REACT = join(HERE, "../tailwindcss.com/react");
const OUT = HERE;
const HERO_CDN = "https://cdn.jsdelivr.net/npm/heroicons@2.2.0";

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else if (ent.name.endsWith(".jsx")) out.push(p);
  }
  return out;
}

function kebab(iconName) {
  return iconName
    .replace(/Icon$/, "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])([0-9])/g, "$1-$2")
    .replace(/([0-9])([A-Za-z])/g, "$1-$2")
    .toLowerCase();
}

function relKit(fromFile, sub) {
  const fromDir = dirname(fromFile);
  let rel = relative(fromDir, join(OUT, "_kit", sub)).replaceAll("\\", "/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function transformReact(src, destTsx) {
  let s = src.replace(/^'use client'\s*\n+/m, "");
  s = s.replace(/\r\n/g, "\n");

  s = s.replace(/import \{([^}]+)\} from 'react'/g, (_, names) => {
    const list = names
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const hooks = list.filter((n) => n.startsWith("use"));
    const rest = list.filter((n) => !n.startsWith("use"));
    const lines = [];
    if (rest.length) lines.push(`import { ${rest.join(", ")} } from 'preact'`);
    if (hooks.length) lines.push(`import { ${hooks.join(", ")} } from 'preact/hooks'`);
    return lines.join("\n");
  });

  s = s.replace(/from '@headlessui\/react'/g, `from '${relKit(destTsx, "headless")}'`);
  s = s.replace(/from '@heroicons\/react\/([^']+)'/g, (_, path) => {
    const file = path.replaceAll("/", "-");
    return `from '${relKit(destTsx, `heroicons/${file}`)}'`;
  });

  // 81 of the upstream templates ship the same untyped `classNames` helper.
  // Its rest parameter is an implicit `any[]`, which is the single largest
  // source of type errors in the ports. The call sites pass class strings,
  // `cond ? 'a' : 'b'`, and `flag && 'a'` — so this union is what they actually
  // hand it, not a guess. Behaviour is unchanged; only the signature is added.
  s = s.replace(
    /^function classNames\(\.\.\.classes\) \{$/m,
    "function classNames(...classes: (string | false | null | undefined)[]) {",
  );

  if (!s.startsWith("/** @jsxImportSource")) {
    s = `/** @jsxImportSource preact */\n${s}`;
  }
  if (!s.endsWith("\n")) s += "\n";
  return s;
}

function astroWrapper(relPath, fileBase) {
  return `---
/**
 * Astro + Preact port of Tailwind UI \`${relPath}\`.
 * Source: the React template (markup 1:1). Island: Preact.
 * Licensed Tailwind UI — reference only; copy into src/ to use.
 */
import Example from "./${fileBase}.tsx";
---

<Example client:load />
`;
}

const iconCache = new Map();

async function fetchIcon(stylePath, iconName) {
  const key = `${stylePath}:${iconName}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const names = [kebab(iconName)];
  if (iconName === "PlusSmallIcon") names.push("plus");
  let svg = null;
  for (const n of names) {
    const url = `${HERO_CDN}/${stylePath}/${n}.svg`;
    const res = await fetch(url);
    if (res.ok) {
      svg = await res.text();
      break;
    }
  }
  if (!svg) {
    console.warn(`missing heroicon ${stylePath}/${iconName}`);
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>';
  }
  iconCache.set(key, svg);
  return svg;
}

function innerOf(svg) {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 24 24";
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .trim();
  const stroke = /stroke="currentColor"/.test(svg);
  return { viewBox, inner, stroke };
}

/**
 * Render `s` as a JS string literal for use inside a JSX *expression container*
 * (`attr={...}`), NOT as a bare JSX attribute (`attr="..."`).
 *
 * This distinction is the bug this generator shipped once already: JSON.stringify
 * escapes `"` as `\"`, which is correct for a JS string literal but meaningless in
 * a JSX attribute, where the value simply ends at the first `"`. The rest of the
 * icon markup was then parsed as JSX attributes and every icon module failed to
 * compile ("Invalid Unicode escape sequence").
 *
 * Single quotes, because Heroicon markup is full of `"` and contains no
 * apostrophes or backslashes — so the literal needs no escaping at all beyond
 * newlines, and oxfmt (which picks whichever quote yields fewer escapes) leaves
 * it alone.
 */
function jsxExprString(s) {
  const body = s.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n");
  return `'${body}'`;
}

/** Emit the shared prop type every icon module imports. */
function renderIconPropsModule() {
  return `import type { JSX } from "preact";

/**
 * Props accepted by every inlined Heroicon in this kit.
 *
 * An icon renders exactly one <svg> and forwards what it is given to it, so it
 * accepts the SVG attributes Preact accepts — nothing invented. Preact's
 * SVGAttributes already extends HTMLAttributes, which is where \`class\` and the
 * React-style \`className\` alias both come from; the Tailwind UI templates we
 * port pass \`className\`, and it type-checks for that reason rather than by
 * special-casing here.
 *
 * \`viewBox\` and \`stroke\` are excluded. Both are genuine SVG attributes, but
 * each icon hard-codes its own viewBox, and \`stroke\` is destructured off as an
 * internal fill-vs-stroke *flag* rather than the paint value its SVG name
 * implies. A caller passing either would have it silently swallowed, so
 * accepting them would be a lie about what the component does.
 */
export interface IconProps extends Omit<JSX.SVGAttributes<SVGSVGElement>, "viewBox" | "stroke"> {}
`;
}

/**
 * @param {{name: string, viewBox: string, inner: string, stroke: boolean}[]} icons
 */
function renderIconModule(icons) {
  const lines = [
    "/** @jsxImportSource preact */",
    "/** Inlined Heroicons (MIT) used by the Tailwind UI React templates. */",
    "",
    'import type { IconProps } from "./props";',
    "",
    "/** An icon's own geometry, plus everything the caller forwards to the <svg>. */",
    "interface InlineIconProps extends IconProps {",
    "  /** viewBox of the source Heroicon. */",
    "  viewBox: string;",
    "  /** Inner markup of the source Heroicon, injected verbatim. */",
    "  inner: string;",
    "  /** Outline icons stroke rather than fill; solid icons do the reverse. */",
    "  stroke: boolean;",
    "}",
    "",
    "function Icon({ viewBox, inner, stroke, className, class: cls, ...rest }: InlineIconProps) {",
    "  const extra = stroke",
    '    ? { fill: "none", stroke: "currentColor", "stroke-width": "1.5" }',
    '    : { fill: "currentColor" };',
    "  return (",
    "    <svg",
    "      viewBox={viewBox}",
    "      class={className ?? cls}",
    '      aria-hidden="true"',
    "      {...extra}",
    "      {...rest}",
    "      dangerouslySetInnerHTML={{ __html: inner }}",
    "    />",
    "  );",
    "}",
    "",
  ];
  for (const { name, viewBox, inner, stroke } of icons) {
    lines.push(`export function ${name}(props: IconProps) {`);
    lines.push(
      `  return <Icon viewBox=${JSON.stringify(viewBox)} inner={${jsxExprString(inner)}} stroke={${stroke}} {...props} />;`,
    );
    lines.push(`}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** @param {{name: string, svg: string}[]} exports */
function writeIconModule(exports) {
  const icons = exports
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, svg }) => ({ name, ...innerOf(svg) }));
  return renderIconModule(icons);
}

async function collectIconImports(files) {
  /** @type {Map<string, Set<string>>} */
  const byStyle = new Map();
  const re = /import \{([^}]+)\} from '@heroicons\/react\/([^']+)'/g;
  for (const file of files) {
    const src = await readFile(file, "utf8");
    for (const m of src.matchAll(re)) {
      const style = m[2];
      if (!byStyle.has(style)) byStyle.set(style, new Set());
      for (const spec of m[1].split(",")) {
        const name = spec
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (name) byStyle.get(style).add(name);
      }
    }
  }
  return byStyle;
}

async function main() {
  const files = await walk(REACT);
  files.sort();
  console.log(`react templates: ${files.length}`);

  const byStyle = await collectIconImports(files);
  await mkdir(join(OUT, "_kit/heroicons"), { recursive: true });
  await writeFile(join(OUT, "_kit/heroicons/props.ts"), renderIconPropsModule());
  for (const [style, names] of byStyle) {
    const exports = [];
    for (const name of names) {
      const svg = await fetchIcon(style, name);
      exports.push({ name, svg });
    }
    const file = `${style.replaceAll("/", "-")}.tsx`;
    await writeFile(join(OUT, "_kit/heroicons", file), writeIconModule(exports));
    console.log(`heroicons ${file}: ${exports.length} icons`);
  }

  let n = 0;
  for (const srcPath of files) {
    const rel = relative(REACT, srcPath).replaceAll("\\", "/"); // e.g. elements/buttons/01-primary-buttons.jsx
    const destTsx = join(OUT, rel.replace(/\.jsx$/, ".tsx"));
    const destAstro = join(OUT, rel.replace(/\.jsx$/, ".astro"));
    await mkdir(dirname(destTsx), { recursive: true });
    const src = await readFile(srcPath, "utf8");
    await writeFile(destTsx, transformReact(src, destTsx));
    const base = rel
      .split("/")
      .pop()
      .replace(/\.jsx$/, "");
    const catalogPath = rel.replace(/\.jsx$/, "");
    await writeFile(destAstro, astroWrapper(catalogPath, base));
    n++;
  }
  console.log(`wrote ${n} .tsx + ${n} .astro`);
}

// Exported so the emitters can be exercised (and the icon modules rebuilt from
// already-inlined data) without a network round-trip to the Heroicons CDN.
export { astroWrapper, jsxExprString, renderIconModule, renderIconPropsModule, transformReact };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
