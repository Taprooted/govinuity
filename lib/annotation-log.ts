import { getDb } from "./db";

export type AnnotationType =
  | "context_restatement_required"
  | "continuity_correction_required"
  | "stale_leakage_detected"
  | "approved_decision_followed"
  | "approved_decision_not_followed";

export const ANNOTATION_TYPES: AnnotationType[] = [
  "context_restatement_required",
  "continuity_correction_required",
  "stale_leakage_detected",
  "approved_decision_followed",
  "approved_decision_not_followed",
];

export type RunAnnotation = {
  annotation_id: string;
  run_id: string;
  ts: string;
  annotation_type: AnnotationType;
  value: boolean;
  decision_id?: string | null;
  note?: string | null;
  annotated_by?: string | null;
};

export function generateAnnotationId(): string {
  return `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function logAnnotation(record: RunAnnotation): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO run_annotations
        (annotation_id, run_id, ts, annotation_type, value, decision_id, note, annotated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.annotation_id,
      record.run_id,
      record.ts,
      record.annotation_type,
      record.value ? 1 : 0,
      record.decision_id ?? null,
      record.note ?? null,
      record.annotated_by ?? null,
    );
  } catch (err) {
    console.error("[annotation-log] Failed to log annotation:", err);
  }
}

export function getAnnotations(filters: {
  run_id?: string;
  annotation_type?: AnnotationType;
  limit?: number;
}): { annotations: RunAnnotation[]; warnings: string[] } {
  const db = getDb();

  let sql = "SELECT * FROM run_annotations";
  const params: unknown[] = [];
  const where: string[] = [];

  if (filters.run_id) {
    where.push("run_id = ?");
    params.push(filters.run_id);
  }
  if (filters.annotation_type) {
    where.push("annotation_type = ?");
    params.push(filters.annotation_type);
  }
  if (where.length > 0) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY ts ASC";

  const rows = db.prepare(sql).all(...params) as any[];
  const limit = filters.limit ?? 200;
  const slice = rows.slice(-limit).reverse();

  const annotations: RunAnnotation[] = slice.map((r) => ({
    annotation_id: r.annotation_id,
    run_id: r.run_id,
    ts: r.ts,
    annotation_type: r.annotation_type as AnnotationType,
    value: r.value === 1,
    decision_id: r.decision_id ?? null,
    note: r.note ?? null,
    annotated_by: r.annotated_by ?? null,
  }));

  return { annotations, warnings: [] };
}
