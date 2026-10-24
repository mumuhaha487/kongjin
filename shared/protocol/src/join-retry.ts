import { ProtocolError } from './types.ts';

export const JOIN_RETRY_MS = 120_000;

function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new ProtocolError('CANCELLED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** One budget across welcome adoption. Retry only HTTP/network failures, never
 * authentication, crypto, application merge or persistence failures. */
export function joinRetrier(signal?: AbortSignal) {
  let started: number | undefined;
  return async function retry<T>(task: () => Promise<T>): Promise<T> {
    for (let attempt = 0;; attempt++) {
      if (signal?.aborted) throw new ProtocolError('CANCELLED');
      try {
        const value = await task();
        if (signal?.aborted) throw new ProtocolError('CANCELLED');
        return value;
      } catch (error) {
        const transient = error instanceof ProtocolError &&
          (error.status === 0 || error.status === 429 || (error.status !== undefined && error.status >= 500 && error.status <= 599));
        if (!transient) throw error;
        started ??= Date.now();
        if (Date.now() - started >= JOIN_RETRY_MS) throw error;
        // A server can ask for more than the budget; never retry before its deadline.
        const requested = Number.isFinite(error.retryAfter) ? Math.max(0, error.retryAfter!) * 1000 : 0;
        await pause(Math.max(Math.min(1000 * 2 ** Math.min(attempt, 4), 15000), requested), signal);
      }
    }
  };
}
