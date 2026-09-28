// Builds the pre-paint appearance script that the conduitAppearanceBoot() Vite plugin inlines into every
// HTML shell (spec 6.2). Plain ESM for Node, so vite.config.ts can import it; never imported by renderer code.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APPEARANCE_BOOT_MARKER = "<!-- conduit:appearance-boot -->";

const PLACEHOLDERS = {
  table: "__CONDUIT_MIGRATION_TABLE__",
  shellColors: "__CONDUIT_SHELL_COLORS__",
};

const APPEARANCE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** JSON that is safe inside an inline <script>: no "</script" and no "<!--". */
function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderBootScript(source, table, shellColors) {
  for (const placeholder of Object.values(PLACEHOLDERS)) {
    if (!source.includes(placeholder)) throw new Error(`boot-inline.js has no ${placeholder} placeholder`);
  }
  return source
    .replace(PLACEHOLDERS.table, () => inlineJson(table))
    .replace(PLACEHOLDERS.shellColors, () => inlineJson(shellColors));
}

export function loadBootScript(dir = APPEARANCE_DIR) {
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
  return renderBootScript(read("boot-inline.js"), JSON.parse(read("migration-table.json")), JSON.parse(read("shell-colors.json")));
}

export function injectBootScript(html, script, fileName) {
  const at = html.indexOf(APPEARANCE_BOOT_MARKER);
  if (at < 0) throw new Error(`${fileName} is missing the ${APPEARANCE_BOOT_MARKER} marker`);
  if (html.indexOf(APPEARANCE_BOOT_MARKER, at + 1) >= 0) throw new Error(`${fileName} has the appearance boot marker twice`);
  return `${html.slice(0, at)}<script>${script}</script>${html.slice(at + APPEARANCE_BOOT_MARKER.length)}`;
}
