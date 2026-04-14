import {
  logAnnotation,
  getAnnotations,
  generateAnnotationId,
  ANNOTATION_TYPES,
} from "../../../lib/annotation-log";
import type { AnnotationType } from "../../../lib/annotation-log";

export async function POST(request: Request) {
  const body = await request.json();
  const { run_id, annotation_type, value, decision_id, note, annotated_by } = body;

  if (!run_id?.trim()) {
    return Response.json({ error: "run_id is required" }, { status: 400 });
  }
  if (!annotation_type || !ANNOTATION_TYPES.includes(annotation_type)) {
    return Response.json(
      { error: `annotation_type must be one of: ${ANNOTATION_TYPES.join(", ")}` },
      { status: 400 },
    );
  }
  if (typeof value !== "boolean") {
    return Response.json({ error: "value must be a boolean" }, { status: 400 });
  }

  const annotation = {
    annotation_id: generateAnnotationId(),
    run_id: run_id.trim(),
    ts: new Date().toISOString(),
    annotation_type: annotation_type as AnnotationType,
    value,
    decision_id: decision_id ?? null,
    note: note?.trim() ?? null,
    annotated_by: annotated_by?.trim() ?? null,
  };

  try {
    logAnnotation(annotation);
    return Response.json({ ok: true, annotation });
  } catch (error) {
    return Response.json(
      { error: String((error as Error).message || error) },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const run_id = searchParams.get("run_id") ?? undefined;
  const annotation_type = searchParams.get("annotation_type") ?? undefined;
  const limit = parseInt(searchParams.get("limit") ?? "200", 10) || 200;

  if (annotation_type && !ANNOTATION_TYPES.includes(annotation_type as AnnotationType)) {
    return Response.json(
      { error: `annotation_type must be one of: ${ANNOTATION_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  const { annotations, warnings } = getAnnotations({
    run_id,
    annotation_type: annotation_type as AnnotationType | undefined,
    limit,
  });

  const by_type = annotations.reduce<Record<string, number>>((acc, a) => {
    acc[a.annotation_type] = (acc[a.annotation_type] ?? 0) + 1;
    return acc;
  }, {});

  return Response.json({ annotations, by_type, total: annotations.length, warnings });
}
