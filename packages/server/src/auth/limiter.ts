/** Thrown by `run` when everything is busy and the queue is full. */
export class LimiterFull extends Error {
  constructor() {
    super('Too much is waiting already');
  }
}

export interface Limiter {
  /** Runs `work` when a place is free. Rejects with `LimiterFull` if it cannot even wait. */
  run<T>(work: () => Promise<T>): Promise<T>;
  stats(): { running: number; waiting: number };
}

/**
 * Lets at most `max` pieces of work run at a time and at most `queue` more wait for a place.
 * Password hashing runs on Node's small thread pool, which file and DNS work share; without a
 * limit a burst of logins would occupy all of it and pile up memory.
 */
export function createLimiter(options: { max: number; queue: number }): Limiter {
  const { max, queue } = options;
  const waiting: (() => void)[] = [];
  let running = 0;
  return {
    async run(work) {
      if (running >= max) {
        if (waiting.length >= queue) throw new LimiterFull();
        // Whoever finishes hands its place straight to the next in line.
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else running++;
      try {
        return await work();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else running--;
      }
    },
    stats: () => ({ running, waiting: waiting.length }),
  };
}
