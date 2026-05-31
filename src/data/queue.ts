type ChunkTimestamp = string;

interface FetchTask {
  ts: ChunkTimestamp;
  priority: 'high' | 'low';
  factory: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
  status: 'queued' | 'active';
}

export class FetchQueue {
  private maxConcurrent = 6;
  private maxPending = 10;
  private active = new Map<ChunkTimestamp, FetchTask>();
  private waiting: FetchTask[] = [];
  private runningCount = 0;
  private onChunkReady: (ts: ChunkTimestamp) => void;
  private latestChunkTimestamp = '';

  constructor(onChunkReady: (ts: ChunkTimestamp) => void) {
    this.onChunkReady = onChunkReady;
  }

  setLatestChunk(ts: string) {
    this.latestChunkTimestamp = ts;
  }

  enqueue(
    ts: ChunkTimestamp,
    priority: 'high' | 'low',
    fetchFn: (signal: AbortSignal) => Promise<void>,
  ): boolean {
    if (ts > this.latestChunkTimestamp) return false;

    if (this.active.has(ts)) {
      const existing = this.active.get(ts)!;
      if (existing.priority === 'low' && priority === 'high') {
        existing.priority = 'high';
        const idx = this.waiting.indexOf(existing);
        if (idx !== -1) {
          this.waiting.splice(idx, 1);
          this.waiting.unshift(existing);
        }
        this.waiting.sort((a, b) => {
          if (a.priority === 'high' && b.priority === 'low') return -1;
          if (a.priority === 'low' && b.priority === 'high') return 1;
          return 0;
        });
      }
      return true;
    }

    const controller = new AbortController();
    const task: FetchTask = {
      ts,
      priority,
      factory: fetchFn,
      controller,
      status: 'queued',
    };

    // Evict if queue is full
    if (this.waiting.length >= this.maxPending) {
      let evicted = false;

      // 1) Drop the oldest low-priority queued task (first low-priority encountered)
      for (let i = 0; i < this.waiting.length; i++) {
        if (this.waiting[i].priority === 'low') {
          this.waiting[i].controller.abort();
          this.waiting.splice(i, 1);
          evicted = true;
          break;
        }
      }

      // 2) No low-priority – drop the oldest queued request (front of array)
      if (!evicted && this.waiting.length > 0) {
        const oldest = this.waiting.shift()!;
        oldest.controller.abort();
        evicted = true;
      }

      // 3) Last resort – abort oldest active low-priority task
      if (!evicted) {
        for (const [key, t] of this.active) {
          if (t.priority === 'low' && t.status === 'active') {
            t.controller.abort();
            this.active.delete(key);
            this.runningCount--;
            break;
          }
        }
      }
    }

    // Insert at front for high priority, at end for low priority
    if (priority === 'high') {
      this.waiting.unshift(task);
    } else {
      this.waiting.push(task);
    }

    this.active.set(ts, task);
    this.processQueue();
    return false;
  }

  cancel(ts: ChunkTimestamp) {
    const task = this.active.get(ts);
    if (task && task.status === 'queued') {
      task.controller.abort();
      this.active.delete(ts);
      this.waiting = this.waiting.filter(t => t.ts !== ts);
    }
  }

  downgradeAllExcept(keepTs: ChunkTimestamp) {
    for (const task of this.active.values()) {
      if (task.ts !== keepTs && task.priority === 'high') {
        task.priority = 'low';
      }
    }
    this.waiting.sort((a, b) => {
      if (a.priority === 'high' && b.priority === 'low') return -1;
      if (a.priority === 'low' && b.priority === 'high') return 1;
      return 0;
    });
  }

  abortAllExcept(keepTs: ChunkTimestamp) {
    for (const [ts, task] of this.active) {
      if (ts !== keepTs) {
        task.controller.abort();
        this.active.delete(ts);
        if (task.status === 'active') {
          this.runningCount--;
        }
      }
    }
    this.waiting = this.waiting.filter(t => t.ts === keepTs);
    this.processQueue();
  }

  private processQueue() {
    this.waiting.sort((a, b) => {
      if (a.priority === 'high' && b.priority === 'low') return -1;
      if (a.priority === 'low' && b.priority === 'high') return 1;
      return 0;
    });

    while (this.runningCount < this.maxConcurrent && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next.status = 'active';
      this.runningCount++;

      next
        .factory(next.controller.signal)
        .then(() => {
          this.active.delete(next.ts);
          this.runningCount--;
          this.onChunkReady(next.ts);
          this.processQueue();
        })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            console.error(`Chunk ${next.ts} fetch failed:`, err);
          }
          this.active.delete(next.ts);
          this.runningCount--;
          this.processQueue();
        });
    }
  }
}
