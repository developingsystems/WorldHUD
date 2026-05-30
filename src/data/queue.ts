type ChunkTimestamp = string;

interface FetchTask {
  ts: ChunkTimestamp;
  priority: 'high' | 'low';
  controller: AbortController;
  promise: Promise<void>;
  status: 'queued' | 'fetching';
}

class FetchQueue {
  private maxConcurrent = 6;
  private maxPending = 10;
  private active = new Map<ChunkTimestamp, FetchTask>();
  private waiting: FetchTask[] = [];
  private fetchingCount = 0;
  private onChunkReady: (ts: ChunkTimestamp) => void;

  constructor(onChunkReady: (ts: ChunkTimestamp) => void) {
    this.onChunkReady = onChunkReady;
  }

  /** Add a chunk request. Returns true if the chunk was already cached or in progress. */
  enqueue(ts: ChunkTimestamp, priority: 'high' | 'low', fetchFn: (signal: AbortSignal) => Promise<void>): boolean {
    // Already cached / in‑flight / queued
    if (this.active.has(ts)) {
      // If existing task is lower priority, upgrade it
      const existing = this.active.get(ts)!;
      if (existing.priority === 'low' && priority === 'high') {
        existing.priority = 'high';
        // Move it to the front of waiting if it's queued
        this.reprioritize(ts, 'high');
      }
      return true;
    }

    const controller = new AbortController();
    const promise = fetchFn(controller.signal).then(() => {
      this.onChunkReady(ts);
      this.active.delete(ts);
      this.fetchingCount--;
      this.processQueue();
    }).catch((err) => {
      if (err.name !== 'AbortError') {
        console.error(`Fetch failed for chunk ${ts}:`, err);
      }
      this.active.delete(ts);
      this.fetchingCount--;
      this.processQueue();
    });

    const task: FetchTask = {
      ts,
      priority,
      controller,
      promise,
      status: 'queued',
    };

    // Evict oldest low‑priority if full
    if (this.waiting.length >= this.maxPending) {
      let evicted = false;
      // Try to drop a low‑priority task
      for (let i = this.waiting.length - 1; i >= 0; i--) {
        if (this.waiting[i].priority === 'low') {
          this.waiting[i].controller.abort();
          this.waiting.splice(i, 1);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        // Drop the oldest low‑priority active (we'll abort it)
        for (const [key, t] of this.active) {
          if (t.priority === 'low' && t.status === 'fetching') {
            t.controller.abort();
            this.active.delete(key);
            this.fetchingCount--;
            break;
          }
        }
      }
    }

    this.waiting.push(task);
    this.active.set(ts, task);
    this.processQueue();
    return false;
  }

  /** Cancel a chunk if it's no longer needed */
  cancel(ts: ChunkTimestamp) {
    const task = this.active.get(ts);
    if (task && task.status === 'queued') {
      task.controller.abort();
      this.active.delete(ts);
      this.waiting = this.waiting.filter(t => t.ts !== ts);
    }
  }

  private reprioritize(ts: ChunkTimestamp, newPriority: 'high') {
    const idx = this.waiting.findIndex(t => t.ts === ts);
    if (idx >= 0) {
      const [task] = this.waiting.splice(idx, 1);
      task.priority = newPriority;
      // Insert at beginning of waiting (since high priority comes first)
      this.waiting.unshift(task);
    }
  }

  private processQueue() {
    while (this.fetchingCount < this.maxConcurrent && this.waiting.length > 0) {
      // Sort waiting: high priority first, then older
      this.waiting.sort((a, b) => {
        if (a.priority === b.priority) return 0;
        return a.priority === 'high' ? -1 : 1;
      });
      const next = this.waiting.shift()!;
      next.status = 'fetching';
      this.fetchingCount++;
      // Fire off fetch (promise already created, just need to start if not already started?
      // Our fetchFn is the actual promise, so it's already started when we called fetchFn.
      // Actually, we called fetchFn when enqueueing, which starts the fetch immediately.
      // To respect concurrency, we need to delay calling fetchFn until the slot is available.
      // So we must change the design: store the factory function, not the promise.
      // I'll adjust: enqueue receives a factory, and we start it in processQueue.
    }
  }
}
