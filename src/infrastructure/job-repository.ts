import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getPool } from './db.js';
import type { JobRecord, JobStatus } from '../domain/types.js';
import { priorityWeight } from '../domain/types.js';

const BACKOFF_SEC = [10, 30, 90, 300];

export function backoffSeconds(attempt: number): number {
  return BACKOFF_SEC[Math.min(attempt - 1, BACKOFF_SEC.length - 1)] ?? 300;
}

/** Pure retry/DLQ decision used by failJob (testable). */
export function isPermanentFailure(
  attempt: number,
  maxRetry: number,
  failureType: 'transient' | 'permanent'
): boolean {
  return failureType === 'permanent' || attempt >= maxRetry;
}

function mapRow(row: Record<string, unknown>): JobRecord {
  return row as unknown as JobRecord;
}

export async function runMigration(sql: string): Promise<void> {
  await getPool().query(sql);
}

export async function createJob(input: {
  jobId?: string;
  queue: string;
  handler: string;
  payload: unknown;
  priority: string;
  maxRetry: number;
  timeoutSec: number;
}): Promise<JobRecord> {
  const jobId = input.jobId ?? randomUUID();
  const result = await getPool().query(
    `INSERT INTO jobs (job_id, queue, handler, payload, priority, max_retry, timeout_sec, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
     ON CONFLICT (job_id) DO NOTHING
     RETURNING *`,
    [
      jobId,
      input.queue,
      input.handler,
      JSON.stringify(input.payload ?? {}),
      priorityWeight(input.priority),
      input.maxRetry,
      input.timeoutSec,
    ]
  );
  if (result.rows[0]) return mapRow(result.rows[0]);
  const existing = await getJobByJobId(jobId);
  if (!existing) throw new Error('Failed to create job');
  return existing;
}

export async function getJobByJobId(jobId: string): Promise<JobRecord | null> {
  const result = await getPool().query('SELECT * FROM jobs WHERE job_id = $1', [jobId]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function leaseNextJob(
  queue: string,
  workerId: string,
  waitTimeSec: number
): Promise<JobRecord | null> {
  const deadline = Date.now() + waitTimeSec * 1000;
  while (Date.now() < deadline) {
    const job = await tryLeaseOnce(queue, workerId);
    if (job) return job;
    await sleep(1000);
  }
  return null;
}

async function tryLeaseOnce(queue: string, workerId: string): Promise<JobRecord | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT * FROM jobs
       WHERE queue = $1 AND status = 'queued'
         AND (next_retry_at IS NULL OR next_retry_at <= now())
       ORDER BY priority DESC, created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [queue]
    );
    if (sel.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    const row = sel.rows[0];
    const leaseId = randomUUID();
    const attempt = Number(row.attempt) + 1;
    const timeoutSec = Number(row.timeout_sec);
    const upd = await client.query(
      `UPDATE jobs SET
         status = 'running', lease_id = $1, worker_id = $2, attempt = $3,
         started_at = COALESCE(started_at, now()), lease_expires_at = now() + ($4 || ' seconds')::interval,
         updated_at = now()
       WHERE id = $5
       RETURNING *`,
      [leaseId, workerId, attempt, timeoutSec, row.id]
    );
    await client.query('COMMIT');
    return mapRow(upd.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function completeJob(leaseId: string): Promise<JobRecord | null> {
  return finishLease(leaseId, 'completed', null);
}

export async function failJob(
  leaseId: string,
  failureType: 'transient' | 'permanent',
  error: { code: string; message: string }
): Promise<JobRecord | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT * FROM jobs WHERE lease_id = $1 AND status = 'running' FOR UPDATE`,
      [leaseId]
    );
    if (sel.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    const job = sel.rows[0];
    const attempt = Number(job.attempt);
    const maxRetry = Number(job.max_retry);
    const permanent = isPermanentFailure(attempt, maxRetry, failureType);

    if (permanent) {
      const upd = await client.query(
        `UPDATE jobs SET status = 'dead_letter', last_error = $1, lease_id = NULL,
         lease_expires_at = NULL, completed_at = now(), updated_at = now()
         WHERE id = $2 RETURNING *`,
        [JSON.stringify(error), job.id]
      );
      await client.query('COMMIT');
      return mapRow(upd.rows[0]);
    }

    const delay = backoffSeconds(attempt);
    const upd = await client.query(
      `UPDATE jobs SET status = 'queued', last_error = $1, lease_id = NULL,
         lease_expires_at = NULL, worker_id = NULL,
         next_retry_at = now() + ($2 || ' seconds')::interval, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [JSON.stringify(error), delay, job.id]
    );
    await client.query('COMMIT');
    return mapRow(upd.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function finishLease(
  leaseId: string,
  status: JobStatus,
  lastError: unknown
): Promise<JobRecord | null> {
  const result = await getPool().query(
    `UPDATE jobs SET status = $1, lease_id = NULL, lease_expires_at = NULL,
       completed_at = CASE WHEN $1 = 'completed' THEN now() ELSE completed_at END,
       last_error = $2, updated_at = now()
     WHERE lease_id = $3 AND status = 'running'
     RETURNING *`,
    [status, lastError ? JSON.stringify(lastError) : null, leaseId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listJobs(queue: string, limit = 50): Promise<JobRecord[]> {
  const result = await getPool().query(
    `SELECT * FROM jobs WHERE queue = $1 ORDER BY created_at DESC LIMIT $2`,
    [queue, limit]
  );
  return result.rows.map(mapRow);
}

export async function cancelJob(jobId: string): Promise<JobRecord | null> {
  const result = await getPool().query(
    `UPDATE jobs SET status = 'cancelled', lease_id = NULL, lease_expires_at = NULL,
       worker_id = NULL, updated_at = now()
     WHERE job_id = $1 AND status IN ('queued', 'running')
     RETURNING *`,
    [jobId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function queueStatus(queue: string) {
  const result = await getPool().query(
    `SELECT status, COUNT(*)::int AS count FROM jobs WHERE queue = $1 GROUP BY status`,
    [queue]
  );
  const depthByStatus: Record<string, number> = {};
  for (const row of result.rows) depthByStatus[row.status] = row.count;

  const pri = await getPool().query(
    `SELECT priority, COUNT(*)::int AS count FROM jobs
     WHERE queue = $1 AND status = 'queued' GROUP BY priority`,
    [queue]
  );
  const depthByPriority: Record<string, number> = {
    critical: 0,
    high: 0,
    normal: 0,
    low: 0,
  };
  const labels: Record<number, string> = { 4: 'critical', 3: 'high', 2: 'normal', 1: 'low' };
  for (const row of pri.rows) {
    const label = labels[Number(row.priority)] ?? 'normal';
    depthByPriority[label] = row.count;
  }
  return { depthByStatus, depthByPriority };
}

export async function sweepExpiredLeases(): Promise<number> {
  const client = await getPool().connect();
  let count = 0;
  try {
    const expired = await client.query(
      `SELECT * FROM jobs WHERE status = 'running' AND lease_expires_at < now() LIMIT 50`
    );
    for (const job of expired.rows) {
      await failJob(String(job.lease_id), 'transient', {
        code: 'LEASE_EXPIRED',
        message: 'Lease expired before completion',
      });
      count++;
    }
  } finally {
    client.release();
  }
  return count;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function toPublicJob(job: JobRecord) {
  const priorityLabels: Record<number, string> = { 4: 'critical', 3: 'high', 2: 'normal', 1: 'low' };
  return {
    jobId: job.job_id,
    queue: job.queue,
    handler: job.handler,
    status: job.status,
    priority: priorityLabels[job.priority] ?? 'normal',
    max_retry: job.max_retry,
    timeout_sec: job.timeout_sec,
    attempt: job.attempt,
    payload: job.payload,
    lastError: job.last_error,
    nextRetryAt: job.next_retry_at,
    workerId: job.worker_id,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
  };
}
