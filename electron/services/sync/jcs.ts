/**
 * RFC 8785 JSON Canonicalization Scheme (spec 3.6 `canon` for JSON values).
 * ES JSON.stringify already serializes numbers and strings the way RFC 8785 requires;
 * canonicalization adds recursive key sorting by UTF-16 code units (the default sort order).
 */

export function jcs(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('jcs: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return Array.isArray(value) ? jcsArray(value) : jcsObject(value as Record<string, unknown>);
    default:
      throw new Error(`jcs: unsupported type ${typeof value}`);
  }
}

function jcsArray(items: readonly unknown[]): string {
  return `[${items.map((item) => (item === undefined ? 'null' : jcs(item))).join(',')}]`;
}

function jcsObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`).join(',')}}`;
}

/** Parses JSON text and returns its JCS form, or null when the text is not valid JSON. */
export function jcsFromText(text: string): string | null {
  try {
    return jcs(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Builds the JCS text of an object from entries whose values are ALREADY JCS texts.
 * Used to write `config` from `config.<key>` registers without re-parsing each value.
 */
export function jcsObjectFromEntries(entries: Iterable<readonly [string, string]>): string {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `{${sorted.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(',')}}`;
}
