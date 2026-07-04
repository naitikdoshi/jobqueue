import type { JobContext, JobHandler, HandlerResult } from '../src/domain/types.js';

export const echoHandler: JobHandler = {
  handlerType: 'echo',
  async handle(_ctx, payload): Promise<HandlerResult> {
    return { outcome: 'success' };
  },
};
