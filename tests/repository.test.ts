import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backoffSeconds, isPermanentFailure, toPublicJob } from '../src/infrastructure/job-repository.js';
import type { JobRecord } from '../src/domain/types.js';

describe('backoffSeconds (S6 retry)', () => {
  it('uses exponential schedule', () => {
    assert.equal(backoffSeconds(1), 10);
    assert.equal(backoffSeconds(2), 30);
    assert.equal(backoffSeconds(3), 90);
    assert.equal(backoffSeconds(4), 300);
    assert.equal(backoffSeconds(99), 300);
  });
});

describe('isPermanentFailure (S5 DLQ / S9 timeout)', () => {
  it('dead_letters when attempt >= max_retry', () => {
    assert.equal(isPermanentFailure(1, 1, 'transient'), true);
    assert.equal(isPermanentFailure(2, 3, 'transient'), false);
    assert.equal(isPermanentFailure(3, 3, 'transient'), true);
  });

  it('dead_letters on permanent failure type', () => {
    assert.equal(isPermanentFailure(1, 5, 'permanent'), true);
  });
});

describe('toPublicJob (S3 status shape)', () => {
  it('maps priority weight to label', () => {
    const job = {
      id: '1',
      job_id: 'j1',
      queue: 'default',
      handler: 'echo',
      payload: { x: 1 },
      priority: 4,
      max_retry: 3,
      timeout_sec: 60,
      status: 'completed',
      attempt: 1,
      lease_id: null,
      worker_id: 'w1',
      last_error: null,
      next_retry_at: null,
      lease_expires_at: null,
      created_at: '2026-01-01T00:00:00Z',
      started_at: '2026-01-01T00:00:01Z',
      completed_at: '2026-01-01T00:00:02Z',
    } as JobRecord;
    const pub = toPublicJob(job);
    assert.equal(pub.priority, 'critical');
    assert.equal(pub.status, 'completed');
    assert.equal(pub.jobId, 'j1');
  });
});
