export type JobStatus =
  | 'queued'
  | 'running'
  | 'failed'
  | 'dead_letter'
  | 'completed'
  | 'cancelled';

export const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export function priorityWeight(label: string): number {
  return PRIORITY_WEIGHT[label] ?? PRIORITY_WEIGHT.normal;
}

export interface JobRecord {
  id: string;
  job_id: string;
  queue: string;
  handler: string;
  payload: unknown;
  priority: number;
  max_retry: number;
  timeout_sec: number;
  status: JobStatus;
  attempt: number;
  lease_id: string | null;
  worker_id: string | null;
  last_error: { code: string; message: string } | null;
  next_retry_at: string | null;
  lease_expires_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface HandlerResult {
  outcome: 'success' | 'transient_failure' | 'permanent_failure';
  error?: { code: string; message: string };
}

export interface JobContext {
  jobId: string;
  leaseId: string;
  attempt: number;
  queue: string;
  signal: AbortSignal;
}

export interface JobHandler {
  readonly handlerType: string;
  handle(ctx: JobContext, payload: unknown): Promise<HandlerResult>;
}
