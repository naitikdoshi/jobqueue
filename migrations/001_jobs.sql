-- Jobs queue schema for DigitalOcean Managed PostgreSQL MVP

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL UNIQUE,
  queue TEXT NOT NULL DEFAULT 'default',
  handler TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  priority INT NOT NULL DEFAULT 2,
  max_retry INT NOT NULL DEFAULT 3,
  timeout_sec INT NOT NULL DEFAULT 300,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt INT NOT NULL DEFAULT 0,
  lease_id UUID,
  worker_id TEXT,
  last_error JSONB,
  next_retry_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_dequeue
  ON jobs (queue, status, priority DESC, created_at ASC)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_jobs_sweeper
  ON jobs (status, lease_expires_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_jobs_status_queue
  ON jobs (queue, status);

CREATE INDEX IF NOT EXISTS idx_jobs_job_id
  ON jobs (job_id);
