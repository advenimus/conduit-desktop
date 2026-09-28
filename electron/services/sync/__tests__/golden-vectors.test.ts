// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CANON_NOTES, HLC_NOTES, RFC8785_EXPECTED, canonInputs, hlcInputs } from './golden-inputs.js';
import { HASHING_NOTES, hashingInputs } from './golden-inputs-hashing.js';
import { buildFile, runCase, serializeFile, type CaseInput, type Json, type VectorFile } from './golden-run.js';

const VECTORS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__vectors__');
const UPDATE = process.env.SYNC_UPDATE_VECTORS === '1';

interface VectorSpec {
  readonly module: string;
  readonly notes: readonly string[];
  readonly inputs: () => CaseInput[];
}

const SPECS: readonly VectorSpec[] = [
  { module: 'canon', notes: CANON_NOTES, inputs: canonInputs },
  { module: 'hashing', notes: HASHING_NOTES, inputs: hashingInputs },
  { module: 'hlc', notes: HLC_NOTES, inputs: hlcInputs },
];

const fileOf = (module: string): string => path.join(VECTORS_DIR, `${module}.json`);

function readVectors(module: string): VectorFile {
  return JSON.parse(fs.readFileSync(fileOf(module), 'utf8')) as VectorFile;
}

describe.each(SPECS)('golden vectors: $module.json', (spec) => {
  const built = buildFile(spec.module, spec.notes, spec.inputs());
  const text = serializeFile(built);

  it('matches a fresh build byte for byte', () => {
    if (UPDATE) {
      fs.mkdirSync(VECTORS_DIR, { recursive: true });
      fs.writeFileSync(fileOf(spec.module), text);
    }
    expect(fs.readFileSync(fileOf(spec.module), 'utf8')).toBe(text);
  });

  it('has unique case names', () => {
    const names = built.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('recomputes every case from its recorded input', () => {
    for (const c of readVectors(spec.module).cases) {
      expect({ name: c.name, output: runCase(c) }).toEqual({ name: c.name, output: c.output as Json });
    }
  });
});

describe('golden vectors: independent oracles', () => {
  const byName = (file: VectorFile): ReadonlyMap<string, Json> => new Map(file.cases.map((c) => [c.name, c.output]));

  it('serializes numbers exactly as RFC 8785 appendix B', () => {
    const outputs = byName(readVectors('canon'));
    for (const [bits, expected] of RFC8785_EXPECTED) {
      expect({ bits, out: outputs.get(`jcsNumber: IEEE-754 ${bits}`) }).toEqual({ bits, out: expected });
    }
  });

  it('pins the JCS key order of RFC 8785 section 3.2.3', () => {
    const out = byName(readVectors('canon')).get('jcs: RFC 8785 3.2.3 key sorting by UTF-16 code units');
    expect(out).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('pins escapes: only controls, quote and backslash are escaped', () => {
    const out = byName(readVectors('canon')).get('jcs: string escapes');
    expect(out).toBe('"\\u0000\\b\\t\\n\\f\\r\\"\\\\/\\u001f\u007f  "');
  });

  it('matches published UUIDv5, SHA-256 and HKDF values', () => {
    const outputs = byName(readVectors('hashing'));
    expect(outputs.get('uuidV5: RFC 4122 DNS example')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(outputs.get('genesisId: abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(outputs.get('hkdf: RFC 5869 case 3 (first 32 bytes)')).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d');
    expect(outputs.get('vrefSecret: null hashes the empty string')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('shows re-encryption changing raw_hash but not the keyed vhash', () => {
    const out = byName(readVectors('hashing')).get('rawHashReencrypt: re-encrypted password') as Array<{ rawHash: string; vhash: string }>;
    expect(out).toHaveLength(2);
    expect(out[0].rawHash).not.toBe(out[1].rawHash);
    expect(out[0].vhash).toBe(out[1].vhash);
    expect(byName(readVectors('hashing')).get('vhashOfSecret: password')).toEqual({ canon: '0368756e74657232', vhash: out[0].vhash });
  });

  it('gives canonical equals equal hashes', () => {
    const outputs = byName(readVectors('hashing'));
    const vhash = (name: string): unknown => (outputs.get(`vhashOfValue: ${name}`) as { vhash: string }).vhash;
    expect(vhash('port integer')).toBe(vhash('port integer text equals integer'));
    expect(vhash('host empty string equals null')).toBe(vhash('host null'));
    expect(vhash('created_at GRDB')).toBe(vhash('created_at ISO equals GRDB'));
    expect(vhash('host')).not.toBe(vhash('same host, other row'));
  });
});
