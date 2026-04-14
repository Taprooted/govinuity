import { getDb } from "../../../lib/db";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const project = searchParams.get("project") ?? null;

  const db = getDb();

  const now = new Date();
  const ts7d  = new Date(now.getTime() - 7  * 86400_000).toISOString();
  const ts30d = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const ts14d = new Date(now.getTime() - 14 * 86400_000).toISOString();

  const projectFilter = project ? "AND project = ?" : "";
  const projectArgs   = project ? [project]          : [];

  // ── Run counts ────────────────────────────────────────────────────────────
  const runs7d = (db.prepare(
    `SELECT COUNT(*) as n FROM continuity_runs WHERE ts >= ? ${projectFilter}`
  ).get(ts7d, ...projectArgs) as { n: number }).n;

  const runs30d = (db.prepare(
    `SELECT COUNT(*) as n FROM continuity_runs WHERE ts >= ? ${projectFilter}`
  ).get(ts30d, ...projectArgs) as { n: number }).n;

  // ── Injection averages (last 30d) ─────────────────────────────────────────
  const injAvg = db.prepare(
    `SELECT AVG(injected_count) as avg_inj, AVG(excluded_count) as avg_exc,
            AVG(duration_ms) as avg_dur, AVG(total_eligible) as avg_elig
     FROM continuity_runs WHERE ts >= ? ${projectFilter}`
  ).get(ts30d, ...projectArgs) as {
    avg_inj: number | null;
    avg_exc: number | null;
    avg_dur: number | null;
    avg_elig: number | null;
  };

  // ── Exclusion reason breakdown (last 30d) ─────────────────────────────────
  // Unnest the JSON excluded array using json_each
  const exclusionRows = db.prepare(`
    SELECT json_extract(e.value, '$.reason') AS reason, COUNT(*) AS n
    FROM continuity_runs r, json_each(r.excluded) e
    WHERE r.ts >= ? ${projectFilter}
    GROUP BY reason
    ORDER BY n DESC
  `).all(ts30d, ...projectArgs) as { reason: string; n: number }[];

  const exclusion_reasons = Object.fromEntries(exclusionRows.map((r) => [r.reason, r.n]));

  // ── Decision utilization: top 15 most-injected decisions (last 30d) ───────
  const utilizationRows = db.prepare(`
    SELECT d_id.value AS decision_id,
           dec.title  AS title,
           COUNT(*)   AS injection_count
    FROM continuity_runs r, json_each(r.injected_ids) d_id
    LEFT JOIN decisions dec ON dec.id = d_id.value
    WHERE r.ts >= ?  ${projectFilter}
    GROUP BY d_id.value
    ORDER BY injection_count DESC
    LIMIT 15
  `).all(ts30d, ...projectArgs) as {
    decision_id: string;
    title: string | null;
    injection_count: number;
  }[];

  // ── Runs per day (last 14 days) ───────────────────────────────────────────
  const runsByDayRows = db.prepare(`
    SELECT substr(ts, 1, 10) AS date, COUNT(*) AS n
    FROM continuity_runs
    WHERE ts >= ? ${projectFilter}
    GROUP BY date
    ORDER BY date ASC
  `).all(ts14d, ...projectArgs) as { date: string; n: number }[];

  // Fill gaps so the chart has a point for every day even if n=0
  const runsByDay: { date: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    const date = d.toISOString().slice(0, 10);
    const row = runsByDayRows.find((r) => r.date === date);
    runsByDay.push({ date, count: row?.n ?? 0 });
  }

  // ── Decision health snapshot ──────────────────────────────────────────────
  const decisionHealth = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'approved')   AS approved,
      COUNT(*) FILTER (WHERE status = 'proposed')   AS proposed,
      COUNT(*) FILTER (WHERE status = 'deferred')   AS deferred,
      COUNT(*) FILTER (WHERE status = 'superseded') AS superseded
    FROM decisions
  `).get() as { approved: number; proposed: number; deferred: number; superseded: number };

  return Response.json({
    runs: {
      last_7d:  runs7d,
      last_30d: runs30d,
    },
    averages: {
      injected_per_run:  injAvg.avg_inj  != null ? Math.round(injAvg.avg_inj  * 10) / 10 : null,
      excluded_per_run:  injAvg.avg_exc  != null ? Math.round(injAvg.avg_exc  * 10) / 10 : null,
      duration_ms:       injAvg.avg_dur  != null ? Math.round(injAvg.avg_dur)             : null,
      eligible_per_run:  injAvg.avg_elig != null ? Math.round(injAvg.avg_elig * 10) / 10 : null,
    },
    exclusion_reasons,
    decision_utilization: utilizationRows,
    runs_by_day: runsByDay,
    decision_health: decisionHealth,
  });
}
