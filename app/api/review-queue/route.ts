import { getDb } from "../../../lib/db";
import { applyReviewDecision } from "../../../lib/review-write";
import { filterByProject, getProjectBySlug, withResolvedProject } from "../../../lib/projects";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectSlug = searchParams.get("project");

  const db = getDb();
  const rows = db.prepare("SELECT * FROM review_queue ORDER BY created_at DESC").all() as Record<string, any>[];

  let items = rows.map((row) => ({
    ...row,
    reviewed: row.reviewed === 1,
    original_entry: typeof row.original_entry === "string" ? JSON.parse(row.original_entry) : row.original_entry,
  })).map((item) => withResolvedProject(item));

  if (projectSlug) {
    const project = getProjectBySlug(projectSlug);
    if (project) {
      items = filterByProject(items, project);
    } else {
      items = [];
    }
  }

  return Response.json({ items, warnings: [] });
}

export async function POST(request: Request) {
  const { id, decision, note } = await request.json();

  try {
    const result = applyReviewDecision({ id, decision, note, reviewedBy: "user" });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: String((error as Error).message || error) }, { status: 500 });
  }
}
