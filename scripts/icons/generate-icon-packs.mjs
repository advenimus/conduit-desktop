#!/usr/bin/env node
// Generates the Codicons and Material Symbols packs and the third-party icon
// license file from the pinned Iconify JSON packages. `--check` compares
// instead of writing and exits 1 when a checked-in file is stale.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ICON_MAPPING } from "./mapping.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

export const OUTPUT_FILES = Object.freeze({
  codicons: "src/lib/icons/generated/codicons.ts",
  material: "src/lib/icons/generated/material.ts",
  licenses: "public/licenses/third-party-icons.txt",
});

const ICONIFY_PACKAGES = Object.freeze({
  codicon: "@iconify-json/codicon",
  material: "@iconify-json/material-symbols-light",
});

// Packages without a LICENSE file of their own use the upstream repository's
// license text, vendored in scripts/icons/licenses/.
export const LICENSE_SOURCES = Object.freeze([
  {
    id: "codicons",
    name: "Codicons",
    packageName: "@iconify-json/codicon",
    license: "CC-BY-4.0",
    notice: "Codicons © Microsoft Corporation, licensed under CC BY 4.0. Converted from SVG to React path data.",
    vendoredText: "codicon.txt",
  },
  {
    id: "lucide",
    name: "Lucide",
    packageName: "lucide-react",
    license: "ISC",
    notice: "Lucide © Lucide Icons and Contributors, licensed under ISC. Portions © Cole Bemis (Feather), licensed under MIT.",
  },
  {
    id: "tabler",
    name: "Tabler Icons",
    packageName: "@tabler/icons-react",
    license: "MIT",
    notice: "Tabler Icons © Paweł Kuna, licensed under MIT.",
  },
  {
    id: "phosphor",
    name: "Phosphor Icons",
    packageName: "@phosphor-icons/react",
    license: "MIT",
    notice: "Phosphor Icons © Phosphor Icons, licensed under MIT.",
  },
  {
    id: "fluent",
    name: "Fluent UI System Icons",
    packageName: "@fluentui/react-icons",
    license: "MIT",
    notice: "Fluent UI System Icons © Microsoft Corporation, licensed under MIT.",
    vendoredText: "fluentui-react-icons.txt",
  },
  {
    id: "material",
    name: "Material Symbols",
    packageName: "@iconify-json/material-symbols-light",
    license: "Apache-2.0",
    notice: "Material Symbols © Google, licensed under Apache 2.0. Converted from SVG to React path data.",
    vendoredText: "material-symbols-light.txt",
  },
]);

const ALLOWED_TAGS = new Set(["path", "g"]);

const ATTR_PATTERNS = Object.freeze({
  d: /^[0-9MmLlHhVvCcSsQqTtAaZzEe.,\s+-]+$/,
  fill: /^(currentColor|none|#[0-9a-fA-F]{3,8})$/,
  "fill-rule": /^(evenodd|nonzero)$/,
  "clip-rule": /^(evenodd|nonzero)$/,
  transform: /^[a-zA-Z0-9.,()\s+-]+$/,
  opacity: /^(0|1|0?\.\d+)$/,
});

const UNSUPPORTED_ICON_PROPS = ["left", "top", "rotate", "hFlip", "vFlip"];

class BodyError extends Error {}

function readAt(re, text, index) {
  re.lastIndex = index;
  return re.exec(text);
}

function parseAttributes(body, start, tag) {
  const attrRe = /\s+([^\s=/>]+)="([^"]*)"/y;
  const endRe = /\s*(\/?)>/y;
  const attrs = {};
  let index = start;
  for (;;) {
    const end = readAt(endRe, body, index);
    if (end) return { attrs, index: index + end[0].length, selfClosing: end[1] === "/" };
    const attr = readAt(attrRe, body, index);
    if (!attr) throw new BodyError(`malformed attribute in <${tag}> at ${index}`);
    const [, name, value] = attr;
    if (!Object.hasOwn(ATTR_PATTERNS, name)) throw new BodyError(`attribute "${name}" is not allowed`);
    if (!ATTR_PATTERNS[name].test(value)) throw new BodyError(`invalid value for "${name}"`);
    if (Object.hasOwn(attrs, name)) throw new BodyError(`duplicate attribute "${name}"`);
    attrs[name] = value;
    index += attr[0].length;
  }
}

/**
 * Parses an Iconify icon body into `{ tag, attrs, children? }` nodes. Only
 * `<path/>` and `<g>` with the allowlisted attributes pass; anything else throws.
 */
export function parseIconBody(body) {
  if (typeof body !== "string") throw new BodyError("body must be a string");
  const openRe = /<([a-zA-Z][a-zA-Z0-9]*)/y;
  const closeRe = /<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/y;
  const spaceRe = /\s+/y;
  const roots = [];
  const stack = [{ tag: null, children: roots }];
  let index = 0;
  while (index < body.length) {
    const space = readAt(spaceRe, body, index);
    if (space) {
      index += space[0].length;
      continue;
    }
    const close = readAt(closeRe, body, index);
    if (close) {
      const top = stack[stack.length - 1];
      if (stack.length === 1 || top.tag !== close[1]) throw new BodyError(`unexpected </${close[1]}>`);
      stack.pop();
      index += close[0].length;
      continue;
    }
    const open = readAt(openRe, body, index);
    if (!open) throw new BodyError(`unexpected content at ${index}`);
    const tag = open[1];
    if (!ALLOWED_TAGS.has(tag)) throw new BodyError(`<${tag}> is not allowed`);
    const parsed = parseAttributes(body, index + open[0].length, tag);
    if (tag === "path" && !parsed.attrs.d) throw new BodyError("<path> without d");
    if (tag === "path" && !parsed.selfClosing) throw new BodyError("<path> must be self-closing");
    const children = [];
    const node = tag === "g" ? { tag, attrs: parsed.attrs, children } : { tag, attrs: parsed.attrs };
    stack[stack.length - 1].children.push(node);
    if (!parsed.selfClosing) stack.push({ tag, children });
    index = parsed.index;
  }
  if (stack.length !== 1) throw new BodyError(`unclosed <${stack[stack.length - 1].tag}>`);
  if (roots.length === 0) throw new BodyError("empty body");
  return roots;
}

/** Resolves an icon or alias to `{ body, width, height }`, honoring per-icon sizes. */
export function resolveIconifyIcon(set, name) {
  const seen = new Set();
  let current = name;
  for (;;) {
    if (seen.has(current)) throw new Error(`${set.prefix}: alias loop at "${current}"`);
    seen.add(current);
    if (set.icons && Object.hasOwn(set.icons, current)) {
      const icon = set.icons[current];
      const unsupported = UNSUPPORTED_ICON_PROPS.filter((key) => key in icon);
      if (unsupported.length > 0) throw new Error(`${set.prefix}:${current} uses ${unsupported.join(", ")}`);
      return {
        body: icon.body,
        width: icon.width ?? set.width ?? 16,
        height: icon.height ?? set.height ?? 16,
      };
    }
    const alias = set.aliases && Object.hasOwn(set.aliases, current) ? set.aliases[current] : null;
    if (!alias) throw new Error(`${set.prefix}: icon "${name}" not found`);
    const extra = Object.keys(alias).filter((key) => key !== "parent");
    if (extra.length > 0) throw new Error(`${set.prefix}: alias "${current}" uses ${extra.join(", ")}`);
    current = alias.parent;
  }
}

function buildGlyph(set, name) {
  const icon = resolveIconifyIcon(set, name);
  try {
    return { w: icon.width, h: icon.height, nodes: parseIconBody(icon.body) };
  } catch (error) {
    throw new Error(`${set.prefix}:${name}: ${error.message}`);
  }
}

function buildGlyphTable(set, names) {
  const sorted = [...new Set(names)].sort();
  return new Map(sorted.map((name) => [name, buildGlyph(set, name)]));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function packageDir(root, packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

function readPackage(root, packageName) {
  const dir = packageDir(root, packageName);
  if (!fs.existsSync(dir)) throw new Error(`${packageName} is not installed; run npm install`);
  return { dir, manifest: readJson(path.join(dir, "package.json")) };
}

function renderGlyphModule({ packageName, version, license, exportName, glyphs, entries }) {
  const glyphLines = [...glyphs].map(([name, glyph]) => `  ${JSON.stringify(name)}: ${JSON.stringify(glyph)},`);
  const entryLines = [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, glyph, compact }) => {
      const ref = `glyphs[${JSON.stringify(glyph)}]`;
      return compact
        ? `  ${name}: { ...${ref}, compact: glyphs[${JSON.stringify(compact)}] },`
        : `  ${name}: ${ref},`;
    });
  return [
    `// Generated by scripts/icons/generate-icon-packs.mjs from ${packageName}@${version} (${license}).`,
    "// Do not edit. Run `npm run icons:generate` after changing scripts/icons/mapping.mjs.",
    'import type { Glyph, GlyphSet } from "../glyph";',
    "",
    "const glyphs: Readonly<Record<string, Glyph>> = {",
    ...glyphLines,
    "};",
    "",
    `export const ${exportName} = {`,
    ...entryLines,
    "} satisfies GlyphSet;",
    "",
  ].join("\n");
}

function normalizeText(text) {
  return `${text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd()}\n`;
}

function declaredLicense(source, dir, manifest) {
  if (source.packageName.startsWith("@iconify-json/")) {
    return readJson(path.join(dir, "info.json")).license?.spdx;
  }
  return manifest.license;
}

function licenseText(source, dir) {
  const own = path.join(dir, "LICENSE");
  if (fs.existsSync(own)) return normalizeText(fs.readFileSync(own, "utf8"));
  if (!source.vendoredText) throw new Error(`${source.packageName} ships no LICENSE file and none is vendored`);
  return normalizeText(fs.readFileSync(path.join(SCRIPT_DIR, "licenses", source.vendoredText), "utf8"));
}

function renderLicenseFile(root) {
  const rule = "=".repeat(76);
  const sections = LICENSE_SOURCES.map((source) => {
    const { dir, manifest } = readPackage(root, source.packageName);
    const declared = declaredLicense(source, dir, manifest);
    if (declared !== source.license) {
      throw new Error(`${source.packageName} declares ${declared}, expected ${source.license}`);
    }
    return [
      rule,
      source.name,
      `Package: ${source.packageName} ${manifest.version}`,
      `License: ${source.license}`,
      source.notice,
      rule,
      "",
      licenseText(source, dir).trimEnd(),
      "",
    ].join("\n");
  });
  return [
    "Third-party icon licenses",
    "",
    "Conduit includes icons from the packages below. Each section names the",
    "package, its version and license, followed by the license text.",
    "Generated by scripts/icons/generate-icon-packs.mjs. Do not edit.",
    "",
    ...sections,
  ].join("\n").trimEnd() + "\n";
}

function loadIconifySet(root, packageName) {
  const { dir, manifest } = readPackage(root, packageName);
  return { set: readJson(path.join(dir, "icons.json")), version: manifest.version };
}

/** Builds every output in memory: `{ [relativePath]: contents }`. */
export function generateOutputs(root = DEFAULT_ROOT) {
  const codicon = loadIconifySet(root, ICONIFY_PACKAGES.codicon);
  const material = loadIconifySet(root, ICONIFY_PACKAGES.material);

  const codiconRows = ICON_MAPPING.filter((row) => row.codicon);
  const codiconGlyphs = buildGlyphTable(
    codicon.set,
    codiconRows.flatMap((row) => (row.codiconCompact ? [row.codicon, row.codiconCompact] : [row.codicon])),
  );
  const materialGlyphs = buildGlyphTable(material.set, ICON_MAPPING.map((row) => row.material));

  return {
    [OUTPUT_FILES.codicons]: renderGlyphModule({
      packageName: ICONIFY_PACKAGES.codicon,
      version: codicon.version,
      license: "CC-BY-4.0",
      exportName: "codiconGlyphs",
      glyphs: codiconGlyphs,
      entries: codiconRows.map((row) => ({ name: row.name, glyph: row.codicon, compact: row.codiconCompact })),
    }),
    [OUTPUT_FILES.material]: renderGlyphModule({
      packageName: ICONIFY_PACKAGES.material,
      version: material.version,
      license: "Apache-2.0",
      exportName: "materialGlyphs",
      glyphs: materialGlyphs,
      entries: ICON_MAPPING.map((row) => ({ name: row.name, glyph: row.material, compact: null })),
    }),
    [OUTPUT_FILES.licenses]: renderLicenseFile(root),
  };
}

/** Returns the relative paths whose checked-in contents differ from a fresh generation. */
export function findStaleOutputs(root = DEFAULT_ROOT) {
  const outputs = generateOutputs(root);
  return Object.entries(outputs)
    .filter(([file, contents]) => {
      const target = path.join(root, file);
      return !fs.existsSync(target) || fs.readFileSync(target, "utf8") !== contents;
    })
    .map(([file]) => file);
}

function writeOutputs(root) {
  const outputs = generateOutputs(root);
  for (const [file, contents] of Object.entries(outputs)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return Object.keys(outputs);
}

function main(argv) {
  const check = argv.includes("--check");
  try {
    if (check) {
      const stale = findStaleOutputs();
      if (stale.length > 0) {
        console.error(`Icon packs are out of date: ${stale.join(", ")}. Run npm run icons:generate.`);
        return 1;
      }
      console.log("Icon packs are up to date.");
      return 0;
    }
    const written = writeOutputs(DEFAULT_ROOT);
    console.log(`Wrote ${written.join(", ")}.`);
    return 0;
  } catch (error) {
    console.error(`Icon generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
