import { echoHandler } from '../../handlers/echo.js';
import { failOnceHandler } from '../../handlers/fail-once.js';
import { slowHandler } from '../../handlers/slow.js';
import type { JobHandler } from '../domain/types.js';

const handlers = new Map<string, JobHandler>();

export function registerHandler(h: JobHandler) {
  handlers.set(h.handlerType, h);
}

export function getHandler(type: string): JobHandler {
  const h = handlers.get(type);
  if (!h) throw new Error(`Unknown handler: ${type}`);
  return h;
}

export function listHandlers(): string[] {
  return [...handlers.keys()];
}

registerHandler(echoHandler);
registerHandler(failOnceHandler);
registerHandler(slowHandler);
