import { useCallback, type Ref, type RefCallback } from "react";

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/** One callback ref that feeds a primitive's own ref and the caller's. */
export function useMergedRef<T>(...refs: ReadonlyArray<Ref<T> | undefined>): RefCallback<T> {
  return useCallback((value: T | null) => refs.forEach((ref) => assignRef(ref, value)), refs);
}
