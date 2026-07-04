import type { JobContext, JobHandler, HandlerResult } from '../src/domain/types.js';

export const failOnceHandler: JobHandler = {
  handlerType: 'fail-once',
  async handle(_ctx, _payload): Promise<HandlerResult> {
    return {
      outcome: 'transient_failure',
      error: { code: 'SIMULATED_FAIL', message: 'Simulated transient failure' },
    };
  },
};
