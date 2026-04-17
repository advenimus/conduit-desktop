/**
 * Offline mutation queue for team vault sync.
 *
 * Queues mutations when the device is offline and flushes them
 * on reconnect. Deduplicates per entity (latest change wins).
 * Capped at 1000 operations.
 */

const MAX_QUEUE_SIZE = 1000;

export interface QueuedMutation {
  entityType: 'entry' | 'folder' | 'password_history';
  action: 'create' | 'update' | 'delete';
  entityId: string;
  timestamp: number;
}

export class OfflineQueue {
  private queue: Map<string, QueuedMutation> = new Map();
  private _isOffline = false;

  get isOffline(): boolean {
    return this._isOffline;
  }

  get size(): number {
    return this.queue.size;
  }

  setOffline(offline: boolean): void {
    this._isOffline = offline;
  }

  /**
   * Add a mutation to the queue. Deduplicates by entityId —
   * if the same entity is mutated again, the latest mutation wins.
   * Delete always wins over create/update.
   */
  enqueue(mutation: QueuedMutation): void {
    const key = `${mutation.entityType}:${mutation.entityId}`;

    const existing = this.queue.get(key);
    if (existing) {
      // Delete supersedes everything
      if (mutation.action === 'delete') {
        this.queue.set(key, mutation);
      } else if (existing.action !== 'delete') {
        // Update the existing mutation with latest data
        this.queue.set(key, mutation);
      }
      // If existing is delete and new is update/create, keep delete
      return;
    }

    // Cap at max size — drop oldest if full
    if (this.queue.size >= MAX_QUEUE_SIZE) {
      const oldest = this.findOldest();
      if (oldest) {
        this.queue.delete(oldest);
      }
    }

    this.queue.set(key, mutation);
  }

  /**
   * Drain the queue, returning all mutations sorted by timestamp.
   * Clears the queue after draining.
   */
  drain(): QueuedMutation[] {
    const mutations = Array.from(this.queue.values());
    mutations.sort((a, b) => a.timestamp - b.timestamp);
    this.queue.clear();
    return mutations;
  }

  /**
   * Peek at all queued mutations without draining.
   */
  peek(): QueuedMutation[] {
    return Array.from(this.queue.values());
  }

  clear(): void {
    this.queue.clear();
  }

  private findOldest(): string | null {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, m] of this.queue) {
      if (m.timestamp < oldestTime) {
        oldestTime = m.timestamp;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
}
