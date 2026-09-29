import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const macIcon = require('../mac-icon.cjs') as {
  ASSET_CATALOG: string;
  sourceHash(source?: string): string;
  stampedHash(): string | null;
};

describe('mac icon', () => {
  it('committed Assets.car was built from the committed icon-macos.icon', () => {
    expect(fs.existsSync(macIcon.ASSET_CATALOG)).toBe(true);
    // If this fails, run `npm run icons:mac` on a Mac with Xcode 26+ and commit build/icons.
    expect(macIcon.stampedHash()).toBe(macIcon.sourceHash());
  });

  describe('sourceHash', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-icon-'));
      fs.mkdirSync(path.join(dir, 'Assets'));
      fs.writeFileSync(path.join(dir, 'icon.json'), '{"fill":{}}');
      fs.writeFileSync(path.join(dir, 'Assets', 'glyph.svg'), '<svg/>');
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('changes when a layer changes', () => {
      const before = macIcon.sourceHash(dir);
      fs.writeFileSync(path.join(dir, 'Assets', 'glyph.svg'), '<svg width="1"/>');
      expect(macIcon.sourceHash(dir)).not.toBe(before);
    });

    it('changes when a file is renamed', () => {
      const before = macIcon.sourceHash(dir);
      fs.renameSync(path.join(dir, 'Assets', 'glyph.svg'), path.join(dir, 'Assets', 'other.svg'));
      expect(macIcon.sourceHash(dir)).not.toBe(before);
    });

    it('ignores Finder metadata', () => {
      const before = macIcon.sourceHash(dir);
      fs.writeFileSync(path.join(dir, 'Assets', '.DS_Store'), 'x');
      expect(macIcon.sourceHash(dir)).toBe(before);
    });
  });
});
