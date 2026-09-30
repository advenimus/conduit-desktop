// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_DTO = path.resolve(HERE, '../dashboard-dto.ts');
const RENDERER_DTO = path.resolve(HERE, '../../../../src/types/dashboard.ts');

function mirrorBlock(file: string): string {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('// ---- MIRROR START');
  const end = text.indexOf('// ---- MIRROR END ----');
  if (start < 0 || end < start) throw new Error(`${path.basename(file)} has no MIRROR block`);
  return text.slice(start, end);
}

describe('dashboard IPC payload types', () => {
  it('main and renderer copies of the MIRROR block are identical', () => {
    expect(mirrorBlock(RENDERER_DTO)).toBe(mirrorBlock(MAIN_DTO));
  });
});
