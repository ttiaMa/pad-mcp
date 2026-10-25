export const DEFAULT_CALL_RATE_LIMIT_PER_MINUTE = 100;
const WINDOW_MS = 60_000;

// One sliding window per authenticated identity, shared by its chats and clients.
export class CallRateLimiter {
  #limit; #now; #windows = new Map(); #nextCleanup = 0;

  constructor(limit = DEFAULT_CALL_RATE_LIMIT_PER_MINUTE, { now = () => performance.now() } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('MCP_CALL_RATE_LIMIT_PER_MINUTE must be a positive safe integer.');
    }
    this.#limit = limit;
    this.#now = now;
  }

  consume(identity) {
    const now = this.#now();
    const cutoff = now - WINDOW_MS;
    if (now >= this.#nextCleanup) {
      for (const [key, timestamps] of this.#windows) {
        if (timestamps.at(-1) <= cutoff) this.#windows.delete(key);
      }
      this.#nextCleanup = now + WINDOW_MS;
    }
    const timestamps = this.#windows.get(identity) ?? [];
    let expired = 0;
    while (expired < timestamps.length && timestamps[expired] <= cutoff) expired++;
    if (expired) timestamps.splice(0, expired);
    if (timestamps.length >= this.#limit) {
      return Math.max(1, Math.ceil((timestamps[0] + WINDOW_MS - now) / 1000));
    }
    timestamps.push(now);
    this.#windows.set(identity, timestamps);
    return 0;
  }
}
