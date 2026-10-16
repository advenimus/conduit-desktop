import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Bundles src/runtime/main.ts into one ESM file and packs it the way Appwrite deployments expect. */
export async function buildFunctionTarball(): Promise<string> {
  const out = join(ROOT, 'dist', 'api');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(ROOT, 'src', 'runtime', 'main.ts')],
    outfile: join(out, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'inline',
    legalComments: 'none',
    // Some bundled CommonJS code calls require(); give the ESM bundle one.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'conduit-api', type: 'module', main: 'main.js' }));
  const tarball = join(ROOT, 'dist', 'api.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', out, 'main.js', 'package.json']);
  return tarball;
}
