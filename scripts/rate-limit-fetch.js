import { setTimeout } from 'node:timers/promises';

export const TRANSFER_REQUEST_TIMEOUT_MS = 240_000;
const MAX_RETRIES = 3;

// Retry only an explicit HTTP rejection, never an uncertain write/network failure.
export function createRateLimitFetch({ fetchImpl = fetch, sleep = setTimeout, warn = console.error } = {}) {
  return async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      init?.signal?.throwIfAborted();
      const response = await fetchImpl(url, init);
      if (response.status !== 429 || attempt === MAX_RETRIES) return response;
      const header = response.headers.get('retry-after');
      const seconds = header !== null && /^\d+$/.test(header) ? Number(header) : NaN;
      // Our one-minute limiter always returns an integer from 1 to 60.
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) return response;
      await response.body?.cancel();
      warn(`Rate limited; retrying in ${seconds}s (${attempt + 1}/${MAX_RETRIES}).`);
      await sleep(seconds * 1000, undefined, { signal: init?.signal });
    }
  };
}
