import { TABLE_BY_NAME } from '../schema/tables.ts';
import type { TableSpec } from '../schema/types.ts';
import { ApiError } from './errors.ts';

export interface Embed {
  alias: string;
  table: TableSpec;
  column: string;
  select: Projection;
}

export interface Projection {
  /** Plain columns, or null for '*'. */
  columns: string[] | null;
  embeds: Embed[];
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (depth !== 0) throw new ApiError('PGRST100', `unbalanced parentheses in select: ${s}`);
  if (cur.trim()) out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** Parses the PostgREST select string the apps use: "*", "a, b", "alias:table ( cols )", "table(*)". */
export function parseSelect(spec: TableSpec, select: string | undefined | null): Projection {
  const text = (select ?? '*').replace(/\s+/g, ' ').trim() || '*';
  const columns: string[] = [];
  let star = false;
  const embeds: Embed[] = [];
  for (const item of splitTopLevel(text)) {
    const m = /^(?:([a-z_][a-z0-9_]*)\s*:\s*)?([a-z_][a-z0-9_]*)\s*(?:!inner)?\s*\((.*)\)$/i.exec(item);
    if (m) {
      const [, alias, target, inner] = m;
      const rel = spec.embeds?.[target!] ?? (alias ? spec.embeds?.[alias] : undefined);
      if (!rel) {
        throw new ApiError('PGRST200', `Could not find a relationship between '${spec.name}' and '${target}' in the schema cache`);
      }
      const table = TABLE_BY_NAME.get(rel.table)!;
      embeds.push({ alias: alias ?? target!, table, column: rel.column, select: parseSelect(table, inner) });
      continue;
    }
    if (item === '*') {
      star = true;
      continue;
    }
    if (!(item in spec.columns)) throw new ApiError('42703', `column ${spec.name}.${item} does not exist`);
    columns.push(item);
  }
  return { columns: star ? null : columns, embeds };
}

export function project(row: Record<string, unknown>, p: Projection): Record<string, unknown> {
  if (p.columns === null) return { ...row };
  const out: Record<string, unknown> = {};
  for (const c of p.columns) out[c] = row[c];
  return out;
}
