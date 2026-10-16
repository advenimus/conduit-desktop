interface NestableRow {
  id: string;
  parent_entry_id?: string | null;
}

/**
 * Returns a new array with every parent before its children, so a local insert never
 * points at a row that is not there yet. Rows whose parent is not in the list, and
 * rows in a cycle, keep their place after the rows that could be ordered.
 */
export function orderParentsFirst<T extends NestableRow>(rows: readonly T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const placed = new Set<string>();
  const ordered: T[] = [];

  const place = (row: T, visiting: Set<string>): void => {
    if (placed.has(row.id) || visiting.has(row.id)) return;
    visiting.add(row.id);
    const parent = row.parent_entry_id ? byId.get(row.parent_entry_id) : undefined;
    if (parent) place(parent, visiting);
    placed.add(row.id);
    ordered.push(row);
  };

  for (const row of rows) place(row, new Set());
  return ordered;
}
