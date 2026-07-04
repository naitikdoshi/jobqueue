import type { JobContext, JobHandler, HandlerResult } from '../src/domain/types.js';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true }
    );
  });
}

export const slowHandler: JobHandler = {
  handlerType: 'slow',
  async handle(ctx, payload): Promise<HandlerResult> {
    const sleepMs = Number((payload as { sleepMs?: number })?.sleepMs ?? 30_000);
    try {
      await sleep(sleepMs, ctx.signal);
      return { outcome: 'success' };
    } catch {
      return {
        outcome: 'transient_failure',
        error: { code: 'TIMEOUT', message: 'Handler aborted (timeout or cancel)' },
      };
    }
  },
};
