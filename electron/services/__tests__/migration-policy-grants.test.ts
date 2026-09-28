// @vitest-environment node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

interface Statement {
  readonly index: number;
  readonly sql: string;
}

/** Applied migrations in order, as statements (comments and $$ bodies removed; they hold no grants). */
function statements(): Statement[] {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const sql = files
    .map((f) => fs.readFileSync(`${MIGRATIONS_DIR}${f}`, 'utf8'))
    .join(';\n')
    .replace(/\$\$[\s\S]*?\$\$/g, "''")
    .replace(/--[^\n]*/g, '');
  return sql.split(';').map((s, index) => ({ index, sql: s.trim().toLowerCase() })).filter((s) => s.sql !== '');
}

function functionNames(fragment: string): string[] {
  return [...fragment.matchAll(/public\.([a-z_][a-z0-9_]*)\s*\(/g)].map((m) => m[1]);
}

/** Last index where `authenticated` lost (revoke from public/authenticated) or got EXECUTE on each function. */
function executeHistory(stmts: Statement[]) {
  const revoked = new Map<string, number>();
  const granted = new Map<string, number>();
  for (const { index, sql } of stmts) {
    const revoke = sql.match(/^revoke execute on function ([\s\S]+?) from ([\s\S]+)$/);
    if (revoke && /\b(public|authenticated)\b/.test(revoke[2])) for (const f of functionNames(revoke[1])) revoked.set(f, index);
    const grant = sql.match(/^grant execute on function ([\s\S]+?) to ([\s\S]+)$/);
    if (grant && /\bauthenticated\b/.test(grant[2])) for (const f of functionNames(`${grant[1]} `.replace(/(^|,\s*)([a-z_]+\s*\()/g, '$1public.$2'))) granted.set(f, index);
  }
  return { revoked, granted };
}

function policyFunctions(stmts: Statement[]): Set<string> {
  const names = new Set<string>();
  for (const { sql } of stmts) {
    if (!sql.startsWith('create policy')) continue;
    for (const m of sql.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/g)) names.add(m[1]);
  }
  return names;
}

describe('supabase migrations: RLS helper functions stay executable', () => {
  it('every function a policy calls that lost EXECUTE for authenticated is granted back later', () => {
    const stmts = statements();
    const { revoked, granted } = executeHistory(stmts);
    const used = [...policyFunctions(stmts)].filter((f) => revoked.has(f));
    expect(used.length).toBeGreaterThan(0);
    const broken = used.filter((f) => (granted.get(f) ?? -1) < (revoked.get(f) ?? -1)).sort();
    expect(broken).toEqual([]);
  });
});
