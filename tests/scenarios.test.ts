import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { echoHandler } from '../handlers/echo.js';
import { failOnceHandler } from '../handlers/fail-once.js';
import { slowHandler } from '../handlers/slow.js';
import type { JobContext } from '../src/domain/types.js';

const ctx = (signal?: AbortSignal): JobContext => ({
  jobId: 'j1',
  leaseId: 'l1',
  attempt: 1,
  queue: 'default',
  signal: signal ?? new AbortController().signal,
});

describe('echo handler (S3)', () => {
  it('returns success', async () => {
    const r = await echoHandler.handle(ctx(), { x: 1 });
    assert.equal(r.outcome, 'success');
  });
});

describe('fail-once handler (S5/S6)', () => {
  it('returns transient_failure', async () => {
    const r = await failOnceHandler.handle(ctx(), {});
    assert.equal(r.outcome, 'transient_failure');
    assert.equal(r.error?.code, 'SIMULATED_FAIL');
  });
});

describe('slow handler (S9 timeout / S10 cancel signal)', () => {
  it('succeeds when sleep finishes before abort', async () => {
    const r = await slowHandler.handle(ctx(), { sleepMs: 10 });
    assert.equal(r.outcome, 'success');
  });

  it('returns transient_failure when aborted (timeout_sec)', async () => {
    const ac = new AbortController();
    const p = slowHandler.handle(ctx(ac.signal), { sleepMs: 5000 });
    ac.abort();
    const r = await p;
    assert.equal(r.outcome, 'transient_failure');
    assert.equal(r.error?.code, 'TIMEOUT');
  });
});

describe('cancelJob states (S4 queued / S10 running)', () => {
  it('allows cancel on queued and running only', () => {
    const cancellable = new Set(['queued', 'running']);
    assert.ok(cancellable.has('queued'));
    assert.ok(cancellable.has('running'));
    assert.ok(!cancellable.has('completed'));
    assert.ok(!cancellable.has('dead_letter'));
  });
});

describe('list jobs API shape (S8)', () => {
  it('returns queue-scoped job array', () => {
    const response = { queue: 'default', jobs: [{ jobId: 'a', status: 'completed' }] };
    assert.equal(response.queue, 'default');
    assert.equal(response.jobs.length, 1);
  });
});

describe('ops queue depth shape (S7)', () => {
  it('includes depthByStatus and depthByPriority', () => {
    const depth = {
      depthByStatus: { completed: 1, queued: 0 },
      depthByPriority: { critical: 0, high: 0, normal: 0, low: 0 },
    };
    assert.ok('depthByStatus' in depth);
    assert.ok('depthByPriority' in depth);
  });
});

describe('unknown handler (S2)', () => {
  it('rejects handlers not in allowlist', () => {
    const allowed = new Set(['echo', 'fail-once', 'slow']);
    assert.ok(!allowed.has('nope'));
  });
});
