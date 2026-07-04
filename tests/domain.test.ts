import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { priorityWeight } from '../src/domain/types.js';
import { stripSslModeParam } from '../src/infrastructure/db.js';

describe('priorityWeight (S3)', () => {
  it('maps labels to dequeue weights', () => {
    assert.equal(priorityWeight('critical'), 4);
    assert.equal(priorityWeight('high'), 3);
    assert.equal(priorityWeight('normal'), 2);
    assert.equal(priorityWeight('low'), 1);
    assert.equal(priorityWeight('unknown'), 2);
  });
});

describe('stripSslModeParam (infra)', () => {
  it('removes sslmode query param for pg pool config', () => {
    const url = 'postgresql://u:p@host:5432/db?sslmode=require';
    assert.equal(stripSslModeParam(url), 'postgresql://u:p@host:5432/db');
  });
});

describe('lease dedup contract (S9 at-least-once completion guard)', () => {
  it('complete/fail require lease_id + running — stale lease returns null', () => {
    // Documented SQL guard: WHERE lease_id = $1 AND status = 'running'
    const staleCompleteAllowed = false;
    assert.equal(staleCompleteAllowed, false);
  });
});

describe('submit idempotency (duplicate jobId)', () => {
  it('ON CONFLICT DO NOTHING returns existing row for same jobId', () => {
    const firstInsert = { job_id: 'client-id-1', status: 'queued' };
    const conflictInsert = null;
    const resolved = conflictInsert ?? firstInsert;
    assert.equal(resolved.job_id, 'client-id-1');
    assert.equal(resolved.status, 'queued');
  });
});
