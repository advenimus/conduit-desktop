// The restyle suite's reference (docs/VISUAL_REDESIGN.md 8.6.1): the lasting folder of before shots and
// its committed manifest, the reference inventory and the allowed deltas, and the side-by-side
// composites of before and after shots.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'restyle');
export const MANIFEST_FILE = path.join(FIXTURES, 'before-manifest.json');
export const INVENTORY_FILE = path.join(FIXTURES, 'before-inventory.json');
export const DELTAS_FILE = path.join(FIXTURES, 'allowed-deltas.json');
export const DEFAULT_BEFORE_DIR = path.join(os.homedir(), '.conduit-verify', 'restyle-before');
const SHOT_NAME = /^(dark|light)-(\d{2}b?)-(.+)\.png$/;
const LABEL_HEIGHT = 56;
const GAP = 24;

/** --before, else CONDUIT_RESTYLE_BEFORE, else ~/.conduit-verify/restyle-before. */
export function beforeDir(options = {}, env = process.env) {
  return path.resolve(options.before ?? (env.CONDUIT_RESTYLE_BEFORE || DEFAULT_BEFORE_DIR));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: ${err.code === 'ENOENT' ? 'missing' : err.message}`);
  }
}

export const loadManifest = (file = MANIFEST_FILE) => readJson(file);
export const loadBeforeInventory = (file = INVENTORY_FILE) => readJson(file);
export const loadDeltas = (file = DELTAS_FILE) => readJson(file).deltas ?? [];

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The manifest of every file in `dir` (sorted by name). */
export function buildManifest(dir) {
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && fs.statSync(path.join(dir, f)).isFile()).sort();
  return { files: Object.fromEntries(files.map((f) => [f, sha256(path.join(dir, f))])) };
}

/**
 * Checks the reference folder against the manifest: {ok, problems}. A listed file that is missing or
 * whose SHA-256 differs is a problem; files the manifest does not list are ignored.
 */
export function verifyReferenceFolder(dir, manifest) {
  const problems = [];
  if (!fs.existsSync(dir)) return { ok: false, problems: [`the reference folder ${dir} does not exist`] };
  for (const [name, hash] of Object.entries(manifest.files ?? {})) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) problems.push(`missing: ${name}`);
    else if (sha256(file) !== hash) problems.push(`changed: ${name}`);
  }
  return { ok: problems.length === 0, problems };
}

/** 'dark-07-main-split-sidebar-pinned.png' -> {mode: 'dark', nn: '07', name: '07-main-split-sidebar-pinned'}. */
export function parseShotName(file) {
  const m = SHOT_NAME.exec(file);
  return m ? { mode: m[1], nn: m[2], name: `${m[2]}-${m[3]}`, file } : null;
}

/** The reference shots of the manifest, as parseShotName results. */
export function referenceShots(manifest) {
  return Object.keys(manifest.files ?? {}).map(parseShotName).filter(Boolean);
}

let sharpModule = null;
async function sharp() {
  sharpModule ??= (await import('sharp')).default;
  return sharpModule;
}

const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** Before on the left, after on the right, scaled to the same height, each labeled; written to `out`. */
export async function writeComposite(beforeFile, afterFile, out, { title = path.basename(out) } = {}) {
  const img = await sharp();
  const [b, a] = await Promise.all([img(beforeFile).metadata(), img(afterFile).metadata()]);
  const height = Math.max(b.height, a.height);
  const scaled = async (file, meta) => {
    const width = Math.round(meta.width * (height / meta.height));
    return { input: await img(file).resize(width, height).png().toBuffer(), width };
  };
  const [bs, as] = await Promise.all([scaled(beforeFile, b), scaled(afterFile, a)]);
  const width = bs.width + GAP + as.width;
  const font = Math.round(LABEL_HEIGHT * 0.5);
  const labels = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_HEIGHT}">
<rect width="100%" height="100%" fill="#202124"/>
<text x="12" y="${Math.round(LABEL_HEIGHT * 0.68)}" font-family="Helvetica, Arial, sans-serif" font-size="${font}" fill="#e8eaed">BEFORE  ${escapeXml(title)}</text>
<text x="${bs.width + GAP + 12}" y="${Math.round(LABEL_HEIGHT * 0.68)}" font-family="Helvetica, Arial, sans-serif" font-size="${font}" fill="#e8eaed">AFTER</text>
</svg>`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await img({ create: { width, height: height + LABEL_HEIGHT, channels: 4, background: '#202124' } })
    .composite([
      { input: labels, left: 0, top: 0 },
      { input: bs.input, left: 0, top: LABEL_HEIGHT },
      { input: as.input, left: bs.width + GAP, top: LABEL_HEIGHT },
    ])
    .png()
    .toFile(out);
  return out;
}

/**
 * Lays `rows` ([[{file, label}]]) out as one labeled sheet, each cell scaled to `cellWidth`; a cell
 * without a file stays empty. Used for the packs sheets of owner gate 1.
 */
export async function writeSheet(rows, out, { cellWidth = 640, title = '' } = {}) {
  const img = await sharp();
  const header = LABEL_HEIGHT;
  const cells = [];
  let y = header;
  for (const row of rows) {
    let rowHeight = 0;
    const placed = [];
    for (const [i, cell] of row.entries()) {
      if (!cell?.file || !fs.existsSync(cell.file)) {
        placed.push(null);
        continue;
      }
      const buf = await img(cell.file).resize(cellWidth, null).png().toBuffer();
      const meta = await img(buf).metadata();
      rowHeight = Math.max(rowHeight, meta.height);
      placed.push({ input: buf, left: i * (cellWidth + GAP), label: cell.label });
    }
    for (const p of placed.filter(Boolean)) {
      cells.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="${header}"><text x="4" y="${Math.round(header * 0.7)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(header * 0.45)}" fill="#e8eaed">${escapeXml(p.label ?? '')}</text></svg>`), left: p.left, top: y });
      cells.push({ input: p.input, left: p.left, top: y + header });
    }
    y += header + rowHeight + GAP;
  }
  const columns = Math.max(...rows.map((r) => r.length));
  const width = columns * cellWidth + (columns - 1) * GAP;
  const titleSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${header}"><rect width="100%" height="100%" fill="#202124"/><text x="4" y="${Math.round(header * 0.7)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(header * 0.5)}" fill="#e8eaed">${escapeXml(title)}</text></svg>`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await img({ create: { width, height: y, channels: 4, background: '#202124' } })
    .composite([{ input: titleSvg, left: 0, top: 0 }, ...cells])
    .png()
    .toFile(out);
  return out;
}
