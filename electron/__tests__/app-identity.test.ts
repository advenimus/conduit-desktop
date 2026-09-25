import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const APP_DATA = path.join('/tmp', 'conduit-app-identity-appdata');

const electronState = vi.hoisted(() => ({
  isPackaged: false,
  name: 'conduit',
  setName: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return electronState.isPackaged; },
    getName: () => electronState.name,
    setName: (name: string) => { electronState.setName(name); electronState.name = name; },
    getPath: (name: string) => {
      if (name !== 'appData') throw new Error(`unexpected getPath(${name})`);
      return APP_DATA;
    },
  },
}));

async function loadIdentity() {
  await import('../app-identity.js');
  return import('../services/env-config.js');
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('CONDUIT_ENV', '');
  electronState.isPackaged = false;
  electronState.name = 'conduit';
  electronState.setName.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('app-identity', () => {
  it('renames the dev build so it gets its own profile and single-instance lock', async () => {
    await loadIdentity();
    expect(electronState.setName).toHaveBeenCalledWith('Conduit Dev');
  });

  it('keeps dev data under the pre-rename name without reading userData', async () => {
    const { getDataDir } = await loadIdentity();
    expect(getDataDir()).toBe(path.join(APP_DATA, 'conduit', 'conduit-dev'));
  });

  it('leaves packaged builds unrenamed with data in the same place', async () => {
    electronState.isPackaged = true;
    const { getDataDir } = await loadIdentity();
    expect(electronState.setName).not.toHaveBeenCalled();
    expect(getDataDir()).toBe(path.join(APP_DATA, 'conduit', 'conduit'));
  });
});

describe('main.ts import order', () => {
  it('imports app-identity before anything that can read userData', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf-8');
    const firstImport = source.split('\n').find(line => line.startsWith('import '));
    expect(firstImport).toBe("import './app-identity.js';");
  });
});
