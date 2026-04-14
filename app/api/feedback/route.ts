import fs from "fs";
import path from "path";
import { PATHS } from "../../../lib/config";
import { readJsonlWithWarnings } from "../../../lib/jsonl";
import { filterByProject, getProjectBySlug, withResolvedProject } from "../../../lib/projects";

const FEEDBACK_PATH = path.join(PATHS.metaDir, "feedback.jsonl");

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") ?? "30", 10) || 30;
  const type = searchParams.get("type");
  const context = searchParams.get("context");
  const projectSlug = searchParams.get("project");

  const { entries: rawEntries, warnings } = readJsonlWithWarnings(FEEDBACK_PATH, "feedback.jsonl");
  let entries = rawEntries.map((parsed) => withResolvedProject(parsed));

  if (type) entries = entries.filter((e) => e.type === type);
  if (context) entries = entries.filter((e) => e.context === context);
  if (projectSlug) {
    const project = getProjectBySlug(projectSlug);
    if (project) {
      entries = filterByProject(entries, project);
    } else {
      entries = [];
    }
  }

  const recent = entries.slice(-limit).reverse();
  return Response.json({ entries: recent, warnings });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.body || typeof body.body !== "string" || !body.body.trim()) {
      return Response.json({ error: "body is required" }, { status: 400 });
    }
    const entry = {
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString(),
      type: body.type ?? "observation",
      body: body.body.trim(),
      context: body.context ?? null,
      source: body.source ?? "user",
      project: body.project ?? null,
    };
    fs.mkdirSync(path.dirname(FEEDBACK_PATH), { recursive: true });
    fs.appendFileSync(FEEDBACK_PATH, JSON.stringify(entry) + "\n", "utf-8");
    return Response.json({ ok: true, entry });
  } catch (error) {
    return Response.json({ error: String((error as Error).message || error) }, { status: 500 });
  }
}
