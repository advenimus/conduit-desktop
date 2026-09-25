/**
 * Native packages ship prebuilt binaries for every platform (better-sqlite3,
 * node-pty, and koffi together add ~90 MB). Keep only the ones for the platform
 * being packaged. Called from afterPack on app.asar.unpacked/node_modules.
 */
const fs = require('fs');
const path = require('path');

const PREBUILD_DIRS = [
  {
    dir: path.join('better-sqlite3', 'prebuilds'),
    keep: (platform, arch) => `${platform}-${arch}.node`,
    // Loaded from here on every platform — never ship without it.
    required: () => true,
  },
  {
    dir: path.join('node-pty', 'prebuilds'),
    keep: (platform, arch) => `${platform}-${arch}`,
    // Fallback only: @electron/rebuild compiles build/Release before packaging.
    required: () => false,
  },
  {
    dir: path.join('koffi', 'build', 'koffi'),
    keep: (platform, arch) => `${platform}_${arch}`,
    // koffi is only loaded on Windows.
    required: (platform) => platform === 'win32',
  },
];

/**
 * Remove every prebuilt binary that isn't for `platform`/`arch` (Node naming:
 * darwin|win32|linux, x64|arm64). Throws, before deleting anything in that
 * package, if a required target binary is missing. Returns removed paths.
 */
function pruneNativePrebuilds(nodeModulesDir, platform, arch) {
  const removed = [];
  for (const { dir, keep, required } of PREBUILD_DIRS) {
    const full = path.join(nodeModulesDir, dir);
    if (!fs.existsSync(full)) continue;

    const target = keep(platform, arch);
    const entries = fs.readdirSync(full);
    if (required(platform) && !entries.includes(target)) {
      throw new Error(`${dir} has no ${target} prebuild; refusing to prune`);
    }

    for (const entry of entries) {
      if (entry === target) continue;
      fs.rmSync(path.join(full, entry), { recursive: true, force: true });
      removed.push(path.join(dir, entry));
    }
  }
  return removed;
}

module.exports = { pruneNativePrebuilds };
