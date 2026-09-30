type SettingsRecord = Record<string, unknown>;

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// Background writers (sync following a moved vault, the recent list) change settings while the dialog is open.
export function mergeChangedSettings<T extends object>(fresh: T, original: T | null, edited: T): T {
  const base = fresh as SettingsRecord;
  const before = original as SettingsRecord | null;
  const after = edited as SettingsRecord;
  const merged: SettingsRecord = { ...base };
  for (const key of Object.keys(after)) {
    if (before === null || !sameValue(after[key], before[key])) merged[key] = after[key];
  }
  return merged as T;
}
