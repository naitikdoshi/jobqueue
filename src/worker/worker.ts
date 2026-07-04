import { getHandler } from './registry.js';
import type { HandlerResult } from '../domain/types.js';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const QUEUES = (process.env.WORKER_QUEUES ?? 'default').split(',');
const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 1);

async function leaseJob(queue: string) {
  const res = await fetch(`${API_URL}/v1/worker/lease`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queue, workerId: WORKER_ID, waitTimeSec: 20 }),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`lease failed: ${res.status}`);
  return res.json();
}

async function reportComplete(leaseId: string) {
  await fetch(`${API_URL}/v1/worker/lease/${leaseId}/complete`, { method: 'POST' });
}

async function reportFail(leaseId: string, result: HandlerResult) {
  const failureType =
    result.outcome === 'permanent_failure' ? 'permanent' : 'transient';
  await fetch(`${API_URL}/v1/worker/lease/${leaseId}/fail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ failureType, error: result.error }),
  });
}

async function processJob(job: {
  jobId: string;
  leaseId: string;
  handler: string;
  payload: unknown;
  attempt: number;
  timeout_sec: number;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), job.timeout_sec * 1000);
  try {
    const handler = getHandler(job.handler);
    const result = await handler.handle(
      {
        jobId: job.jobId,
        leaseId: job.leaseId,
        attempt: job.attempt,
        queue: QUEUES[0],
        signal: controller.signal,
      },
      job.payload
    );
    if (result.outcome === 'success') {
      await reportComplete(job.leaseId);
    } else {
      await reportFail(job.leaseId, result);
    }
  } catch (e) {
    await reportFail(job.leaseId, {
      outcome: 'transient_failure',
      error: { code: 'HANDLER_ERROR', message: String(e) },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function workerLoop(queue: string) {
  for (;;) {
    try {
      const job = await leaseJob(queue);
      if (!job) continue;
      await processJob(job);
    } catch (e) {
      console.error('worker error', e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  console.log('Worker starting', { API_URL, WORKER_ID, QUEUES, CONCURRENCY });
  await Promise.all(
    QUEUES.flatMap((q) => Array.from({ length: CONCURRENCY }, () => workerLoop(q)))
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
