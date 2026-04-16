import { getDb } from "../../../../../lib/db";

type RunRow = {
  run_id: string;
  ts: string;
  project?: string | null;
  agent?: string | null;
  source?: string | null;
};

type ExcludedRunRow = RunRow & {
  excluded: unknown;
};

type AnnotationRow = {
  annotation_id: string;
  run_id: string;
  ts: string;
  annotation_type: string;
  value: number | boolean;
  decision_id?: string | null;
  note?: string | null;
  annotated_by?: string | null;
};

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = getDb();

  const injectedRows = db.prepare(`
    SELECT r.run_id, r.ts, r.project, r.agent, r.source
    FROM continuity_runs r, json_each(r.injected_ids) injected
    WHERE injected.value = ?
    ORDER BY r.ts DESC
  `).all(id) as RunRow[];

  const excludedRows = db.prepare(`
    SELECT r.run_id, r.ts, r.project, r.agent, r.source, excluded.value AS excluded
    FROM continuity_runs r, json_each(r.excluded) excluded
    WHERE json_extract(excluded.value, '$.id') = ?
    ORDER BY r.ts DESC
  `).all(id) as ExcludedRunRow[];

  const annotationRows = db.prepare(`
    SELECT annotation_id, run_id, ts, annotation_type, value, decision_id, note, annotated_by
    FROM run_annotations
    WHERE decision_id = ?
    ORDER BY ts DESC
  `).all(id) as AnnotationRow[];

  const excluded = excludedRows.map((row) => {
    const parsed = parseJsonObject(row.excluded);
    return {
      run_id: row.run_id,
      ts: row.ts,
      project: row.project,
      agent: row.agent,
      source: row.source,
      reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
      title: typeof parsed.title === "string" ? parsed.title : id,
    };
  });

  const annotations = annotationRows.map((row) => ({
    ...row,
    value: row.value === 1 || row.value === true,
  }));

  const annotation_counts = annotations.reduce<Record<string, number>>((acc, row) => {
    const type = String(row.annotation_type);
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});

  const exclusion_reasons = excluded.reduce<Record<string, number>>((acc, row) => {
    acc[row.reason] = (acc[row.reason] ?? 0) + 1;
    return acc;
  }, {});

  const recent_runs = [
    ...injectedRows.map((row) => ({
      run_id: row.run_id,
      ts: row.ts,
      project: row.project,
      agent: row.agent,
      source: row.source,
      result: "injected",
    })),
    ...excluded.map((row) => ({
      run_id: row.run_id,
      ts: row.ts,
      project: row.project,
      agent: row.agent,
      source: row.source,
      result: "excluded",
      reason: row.reason,
    })),
  ]
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, 10);

  return Response.json({
    decision_id: id,
    summary: {
      injected_count: injectedRows.length,
      excluded_count: excludedRows.length,
      annotation_count: annotations.length,
      annotation_counts,
      exclusion_reasons,
    },
    recent_runs,
    annotations: annotations.slice(0, 20),
    warnings: [],
  });
}
