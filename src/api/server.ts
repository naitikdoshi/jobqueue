import Fastify from 'fastify';
import { pingDb } from '../infrastructure/db.js';
import {
  createJob,
  getJobByJobId,
  listJobs,
  leaseNextJob,
  completeJob,
  failJob,
  cancelJob,
  queueStatus,
  sweepExpiredLeases,
  toPublicJob,
} from '../infrastructure/job-repository.js';
import { listHandlers } from '../worker/registry.js';

const ALLOWED = new Set(
  (process.env.ALLOWED_HANDLERS ?? 'echo,fail-once,slow').split(',').map((s) => s.trim())
);

export async function buildServer() {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_req, reply) => {
    try {
      await pingDb();
      return { postgres: 'ok' };
    } catch {
      return reply.code(503).send({ postgres: 'error' });
    }
  });

  app.post<{ Body: Record<string, unknown> }>('/v1/jobs', async (req, reply) => {
    const body = req.body ?? {};
    const handler = String(body.handler ?? '');
    if (!ALLOWED.has(handler)) {
      return reply.code(400).send({ error: 'unknown_handler', handler });
    }
    const job = await createJob({
      jobId: body.jobId ? String(body.jobId) : undefined,
      queue: String(body.queue ?? 'default'),
      handler,
      payload: body.payload ?? {},
      priority: String(body.priority ?? 'normal'),
      maxRetry: Number(body.max_retry ?? 3),
      timeoutSec: Number(body.timeout_sec ?? 300),
    });
    return reply.code(201).send(toPublicJob(job));
  });

  app.get<{ Querystring: { queue?: string; limit?: string } }>('/v1/jobs', async (req) => {
    const queue = String(req.query.queue ?? 'default');
    const limit = Math.min(Number(req.query.limit ?? 50), 100);
    const jobs = await listJobs(queue, limit);
    return { queue, jobs: jobs.map(toPublicJob) };
  });

  app.get<{ Params: { jobId: string } }>('/v1/jobs/:jobId', async (req, reply) => {
    const job = await getJobByJobId(req.params.jobId);
    if (!job) return reply.code(404).send({ error: 'not_found' });
    return toPublicJob(job);
  });

  app.post<{ Body: { queue?: string; workerId?: string; waitTimeSec?: number } }>(
    '/v1/worker/lease',
    async (req, reply) => {
      const queue = String(req.body?.queue ?? 'default');
      const workerId = String(req.body?.workerId ?? 'worker-unknown');
      const waitTimeSec = Math.min(Number(req.body?.waitTimeSec ?? 20), 20);
      const job = await leaseNextJob(queue, workerId, waitTimeSec);
      if (!job) return reply.code(204).send();
      return {
        jobId: job.job_id,
        leaseId: job.lease_id,
        handler: job.handler,
        payload: job.payload,
        attempt: job.attempt,
        timeout_sec: job.timeout_sec,
      };
    }
  );

  app.post<{ Params: { leaseId: string } }>(
    '/v1/worker/lease/:leaseId/complete',
    async (req, reply) => {
      const job = await completeJob(req.params.leaseId);
      if (!job) return reply.code(409).send({ error: 'lease_expired' });
      return { status: job.status };
    }
  );

  app.post<{ Params: { leaseId: string }; Body: { failureType?: string; error?: { code: string; message: string } } }>(
    '/v1/worker/lease/:leaseId/fail',
    async (req, reply) => {
      const ft = req.body?.failureType === 'permanent' ? 'permanent' : 'transient';
      const err = req.body?.error ?? { code: 'UNKNOWN', message: 'failed' };
      const job = await failJob(req.params.leaseId, ft, err);
      if (!job) return reply.code(409).send({ error: 'lease_expired' });
      return { status: job.status, attempt: job.attempt };
    }
  );

  app.get<{ Params: { queue: string } }>('/v1/ops/queues/:queue/status', async (req) => {
    return queueStatus(req.params.queue);
  });

  app.post<{ Params: { jobId: string } }>('/v1/ops/jobs/:jobId/cancel', async (req, reply) => {
    const job = await cancelJob(req.params.jobId);
    if (!job) {
      const existing = await getJobByJobId(req.params.jobId);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      return toPublicJob(existing);
    }
    return toPublicJob(job);
  });

  return app;
}

export async function startApi() {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  setInterval(() => {
    sweepExpiredLeases().catch((e) => app.log.error(e));
  }, 30_000);

  await app.listen({ port, host });
  app.log.info({ handlers: listHandlers() }, 'API started');
}
