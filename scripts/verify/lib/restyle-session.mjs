// One restyle scenario's recorder (docs/VISUAL_REDESIGN.md 8.6): after shots under the reference
// names, composites with their before twins, inventories compared with the reference, geometry rules,
// and the scenario's inventory.json and inventory-diff.txt. finish() fails the scenario on any
// inventory difference, failed rule, missing composite or reference problem (and on pending rules
// with --strict).

import fs from 'node:fs';
import path from 'node:path';
import { evaluateRules, summarizeRules } from './geometry.mjs';
import { captureInventory, compareInventory, normalizeInventory } from './inventory.mjs';
import { beforeDir, loadBeforeInventory, loadDeltas, loadManifest, verifyReferenceFolder, writeComposite } from './restyle-reference.mjs';
import { captureWindow, cropCapture } from './window-capture.mjs';
import { sleep } from './ui.mjs';

const SETTLE_MS = 450;

/** Everything a scenario records, bound to its output folder. */
export function createRestyleSession(ctx, scenarioId, { shots = [] } = {}) {
  const dir = beforeDir(ctx.options);
  const manifest = loadManifest();
  const reference = verifyReferenceFolder(dir, manifest);
  if (!reference.ok) {
    throw new Error(`Reference folder ${dir} does not match fixtures/restyle/before-manifest.json:\n  ${reference.problems.join('\n  ')}`);
  }
  const before = loadBeforeInventory();
  const deltas = loadDeltas();
  const root = path.join(ctx.run.runDir, 'restyle');
  const out = { after: path.join(root, 'after'), compare: path.join(root, 'compare'), scenario: path.join(root, scenarioId) };
  for (const d of Object.values(out)) fs.mkdirSync(d, { recursive: true });

  const captures = [];
  const inventories = [];
  const rules = [];
  const composites = new Set();
  const problems = [];
  const hasReference = (mode, name) => Object.hasOwn(manifest.files, `${mode}-${name}.png`);
  // A declared shot with no reference in either mode is new: it is captured in both modes so it can
  // be added to the reference folder, and the scenario fails until it is.
  const unrecorded = (name) => !hasReference('dark', name) && !hasReference('light', name);

  /**
   * Screenshots the device under reference name `name` (for example '07-main-split-sidebar-pinned')
   * when a `mode` twin exists in the reference, and writes the composite. `crop(capture)` returns a
   * {x, y, width, height, zoom} region in CSS pixels of the content area. Returns the after file or null.
   */
  async function shot(device, mode, name, { crop, overlays } = {}) {
    const record = shots.includes(name) && unrecorded(name);
    if (!hasReference(mode, name) && !record) return null;
    await sleep(SETTLE_MS);
    const file = path.join(out.after, `${mode}-${name}.png`);
    const full = crop ? `${file}.full.png` : file;
    const capture = await captureWindow(device, full, overlays ? { overlays } : undefined);
    if (device.captureWarning) {
      problems.push(`${mode}-${name}: ${device.captureWarning}`);
      device.captureWarning = null;
    }
    if (crop) {
      const region = await crop(capture);
      await cropCapture(capture, region, file, { zoom: region.zoom ?? 1 });
      fs.rmSync(full, { force: true });
    }
    if (record) {
      ctx.step(`shot ${mode}-${name} (no reference yet)`);
      return file;
    }
    await writeComposite(path.join(dir, `${mode}-${name}.png`), file, path.join(out.compare, `${mode}-${name}.png`), { title: `${mode}-${name}` });
    composites.add(`${mode}-${name}`);
    ctx.step(`shot ${mode}-${name}`);
    return file;
  }

  function probesFor(screen) {
    return [...new Set(deltas.filter((d) => d.screen === screen).flatMap((d) => (d.changes ?? []).map((c) => c.insertWhen).filter(Boolean)))];
  }

  function compareWithReference(mode, capture, vaultDirs) {
    const reference = before.screens?.[capture.screen];
    const after = normalizeInventory(capture, { vaultDirs });
    captures.push({ mode, ...after });
    if (!reference) {
      inventories.push({ screen: capture.screen, mode, ok: false, lines: ['no reference inventory for this screen'] });
      return;
    }
    const result = compareInventory({ screen: capture.screen, ...reference }, after, deltas);
    inventories.push({ screen: capture.screen, mode, ...result });
    ctx.step(`inventory ${mode} ${capture.screen}: ${result.ok ? 'matches' : `${result.lines.length} difference(s)`}`);
  }

  /** Records controls screen `screen` ({name, roots}) and compares it. */
  async function inventory(device, mode, screen, { vaultDirs = [] } = {}) {
    const capture = await captureInventory(device, { ...screen, probes: probesFor(screen.name) });
    compareWithReference(mode, capture, vaultDirs);
  }

  /** Compares a menu read with captureMenu or captureAppMenu as screen `name`. */
  function menu(mode, name, items) {
    compareWithReference(mode, { screen: name, kind: 'menu', items }, []);
  }

  /** Runs the geometry rules on the current screen. */
  async function check(device, mode, label, opts = {}) {
    rules.push({ screen: `${mode} ${label}`, results: await evaluateRules(device, opts) });
  }

  /** A rule result recorded by the scenario itself (the twelve-tab part of G10, the packs checks). */
  function record(mode, label, result) {
    rules.push({ screen: `${mode} ${label}`, results: [result] });
  }

  function missingComposites() {
    return shots.flatMap((name) => ['dark', 'light']
      .filter((m) => (hasReference(m, name) || unrecorded(name)) && !composites.has(`${m}-${name}`))
      .map((m) => `${m}-${name}${unrecorded(name) ? ' (not in the reference folder)' : ''}`));
  }

  /** Writes inventory.json and inventory-diff.txt; throws when anything failed. */
  function finish() {
    const summary = summarizeRules(rules, { strict: ctx.options.strict });
    const missing = missingComposites();
    const badInventories = inventories.filter((i) => !i.ok);
    const lines = [`restyle/${scenarioId}${ctx.options.strict ? ' (--strict)' : ''}`, '', 'INVENTORIES'];
    for (const i of inventories) {
      lines.push(`${i.ok ? 'OK  ' : 'FAIL'} ${i.mode} ${i.screen}`);
      for (const l of i.lines) lines.push(`       ${l}`);
    }
    lines.push('', 'GEOMETRY RULES', ...summary.lines, '', `pending: ${summary.pending}${ctx.options.strict ? ' (failures under --strict)' : ''}`);
    if (missing.length > 0) lines.push('', 'MISSING COMPOSITES', ...missing.map((m) => `  ${m}`));
    if (problems.length > 0) lines.push('', 'PROBLEMS', ...problems.map((p) => `  ${p}`));
    fs.writeFileSync(path.join(out.scenario, 'inventory.json'), `${JSON.stringify({ scenario: scenarioId, captures }, null, 2)}\n`);
    fs.writeFileSync(path.join(out.scenario, 'inventory-diff.txt'), `${lines.join('\n')}\n`);
    ctx.step(`${inventories.length - badInventories.length}/${inventories.length} inventories match, ${summary.failed} rule failure(s), ${summary.pending} pending, ${composites.size} composite(s)`);
    const failures = [
      ...badInventories.map((i) => `inventory ${i.mode} ${i.screen} differs`),
      ...(summary.failed > 0 ? [`${summary.failed} geometry rule failure(s)`] : []),
      ...missing.map((m) => `no composite for ${m}`),
      ...problems,
    ];
    if (failures.length > 0) throw new Error(`${failures.join('; ')} (see ${path.relative(ctx.run.runDir, path.join(out.scenario, 'inventory-diff.txt'))})`);
  }

  return { dir, out, manifest, shot, inventory, menu, check, record, finish, hasReference };
}
