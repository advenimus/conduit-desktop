/**
 * Shared app lifecycle state — avoids circular imports between main.ts and IPC modules.
 */

let _isQuitting = false;

export function isQuitting(): boolean {
  return _isQuitting;
}

export function setIsQuitting(value: boolean): void {
  _isQuitting = value;
}
