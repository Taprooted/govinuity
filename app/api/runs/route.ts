import { getDb } from "../../../lib/db";
import { logContinuityRun, generateRunId } from "../../../lib/run-log";
import { getActiveDecisions } from "../../../lib/decision-write";
import type { ContinuityRunRecord } from "../../../lib/run-log";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") ?? "50", 10) || 50;
  const project = searchParams.get("project");

  const db = getDb();

  let query = "SELECT * FROM continuity_runs";
  const params: any[] = [];
  if (project) {
    query += " WHERE project = ?";
    params.push(project);
  }
  query += " ORDER BY ts DESC";

  const allRuns = db.prepare(query).all(...params) as Record<string, any>[];

  const runs = allRuns.map((r) => ({
    ...r,
    injected_ids: typeof r.injected_ids === "string" ? JSON.parse(r.injected_ids) : (r.injected_ids ?? []),
    excluded: typeof r.excluded === "string" ? JSON.parse(r.excluded) : (r.excluded ?? []),
  })) as ContinuityRunRecord[];

  const total = runs.length;
  const recent = runs.slice(0, limit);

  const stats = {
    total_runs: total,
    total_injected: runs.reduce((s, r) => s + r.injected_count, 0),
    total_excluded: runs.reduce((s, r) => s + r.excluded_count, 0),
    exclusion_reasons: runs
      .flatMap((r) => r.excluded)
      .reduce<Record<string, number>>((acc, e) => {
        acc[e.reason] = (acc[e.reason] ?? 0) + 1;
        return acc;
      }, {}),
  };

  return Response.json({ runs: recent, total, stats, warnings: [] });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { project, source, ts, note } = body;

  if (ts !== undefined && ts !== null) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) {
      return Response.json({ error: "ts must be a valid ISO date string" }, { status: 400 });
    }
  }

  const decisions = getActiveDecisions({ project: project ?? undefined });
  const run_id = generateRunId();
  const timestamp = ts || new Date().toISOString();

  logContinuityRun({
    run_id,
    ts: timestamp,
    project: project ?? null,
    app: null,
    agent: note?.trim() ? `manual: ${note.trim()}` : "manual",
    source: source ?? "file",
    injected_ids: decisions.map((d) => d.id),
    excluded: [],
    injected_count: decisions.length,
    excluded_count: 0,
  });

  return Response.json({ ok: true, run_id, injected_count: decisions.length, ts: timestamp });
}
