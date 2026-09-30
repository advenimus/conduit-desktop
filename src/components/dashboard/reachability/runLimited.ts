/** Runs `worker` over `items` in order with at most `limit` running at once. Resolves when all settle; a failing item does not stop the rest. */
export async function runLimited<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await worker(item);
      } catch {
        // The worker reports its own failures.
      }
    }
  };
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane);
  await Promise.all(lanes);
}
