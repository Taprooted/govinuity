import { getDb } from "./db";

export type ContinuityRunRecord = {
  run_id: string;
  ts: string;
  project?: string | null;
  app?: string | null;
  agent?: string | null;
  source?: string | null;
  task_ref?: string | null;
  injected_ids: string[];
  excluded: Array<{ id: string; title: string; reason: string }>;
  injected_count: number;
  excluded_count: number;
  total_eligible?: number | null;
  duration_ms?: number | null;
};

export function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Insert a continuity run record into the DB.
 * Non-fatal: if logging fails, memory serving is unaffected.
 */
export function logContinuityRun(record: ContinuityRunRecord): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO continuity_runs
        (run_id, ts, project, app, agent, source, task_ref,
         injected_ids, excluded, injected_count, excluded_count,
         total_eligible, duration_ms)
      VALUES
        (@run_id, @ts, @project, @app, @agent, @source, @task_ref,
         @injected_ids, @excluded, @injected_count, @excluded_count,
         @total_eligible, @duration_ms)
    `).run({
      run_id: record.run_id,
      ts: record.ts,
      project: record.project ?? null,
      app: record.app ?? null,
      agent: record.agent ?? null,
      source: record.source ?? null,
      task_ref: record.task_ref ?? null,
      injected_ids: JSON.stringify(record.injected_ids),
      excluded: JSON.stringify(record.excluded),
      injected_count: record.injected_count,
      excluded_count: record.excluded_count,
      total_eligible: record.total_eligible ?? null,
      duration_ms: record.duration_ms ?? null,
    });
  } catch (err) {
    // non-fatal — logging must never break memory serving
    console.error("[run-log] failed to write continuity run:", err);
  }
}
