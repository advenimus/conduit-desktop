// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('desktop copy of the api client', () => {
  it('conduit-db.ts is appwrite/src/client/index.ts plus its header line', () => {
    expect(read('electron/services/backend/conduit-db.ts').split('\n').slice(1).join('\n')).toBe(read('appwrite/src/client/index.ts'));
  });

  it('transport.ts is appwrite/src/client/appwrite-transport.ts with the import path changed', () => {
    expect(read('electron/services/backend/transport.ts')).toBe(read('appwrite/src/client/appwrite-transport.ts').replace("from './index.ts';", "from './conduit-db.js';"));
  });
});
