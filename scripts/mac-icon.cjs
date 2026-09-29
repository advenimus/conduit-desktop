// The macOS 26+ app icon: resources/icons/icon-macos.icon (Icon Composer) is compiled by
// scripts/build-mac-icon.sh into build/icons/Assets.car, which is committed because the release
// runner (macos-14) has no actool that reads .icon files. The stamp file records which source the
// committed Assets.car came from, so a packaged build fails instead of shipping a stale icon.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ICON_SOURCE = path.join(ROOT, 'resources', 'icons', 'icon-macos.icon');
const ASSET_CATALOG = path.join(ROOT, 'build', 'icons', 'Assets.car');
const SOURCE_STAMP = path.join(ROOT, 'build', 'icons', 'Assets.car.source-sha256');
const ICON_NAME = 'Icon';

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== '.DS_Store')
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    })
    .sort();
}

function sourceHash(source = ICON_SOURCE) {
  const hash = crypto.createHash('sha256');
  for (const rel of listFiles(source)) {
    hash.update(`${rel}\0`);
    hash.update(fs.readFileSync(path.join(source, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function stampedHash() {
  return fs.existsSync(SOURCE_STAMP) ? fs.readFileSync(SOURCE_STAMP, 'utf8').trim() : null;
}

function writeStamp() {
  fs.writeFileSync(SOURCE_STAMP, `${sourceHash()}\n`);
}

module.exports = { ICON_SOURCE, ASSET_CATALOG, SOURCE_STAMP, ICON_NAME, sourceHash, stampedHash, writeStamp };

if (require.main === module && process.argv[2] === 'stamp') {
  writeStamp();
}
