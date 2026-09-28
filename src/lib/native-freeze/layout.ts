export const LAYOUT_CHANGED_EVENT = "conduit:layout-changed";

type RequestFrame = (callback: FrameRequestCallback) => number;

/** Returns a function that dispatches one LAYOUT_CHANGED_EVENT per animation frame, however often it is called. */
export function createLayoutNotifier(target: EventTarget, requestFrame: RequestFrame): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    requestFrame(() => {
      pending = false;
      target.dispatchEvent(new CustomEvent(LAYOUT_CHANGED_EVENT));
    });
  };
}
