import fs from "fs";
import path from "path";
import { aggregateProject, getProjects, PROJECTS_PATH } from "../../../lib/projects";

export async function GET() {
  const projects = getProjects();
  return Response.json({
    projects: projects.map((project) => aggregateProject(project)),
  });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { slug, name, description, color, context_keys } = body;

  if (!slug?.trim() || !name?.trim()) {
    return Response.json({ error: "slug and name are required" }, { status: 400 });
  }

  const slugClean = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!slugClean) {
    return Response.json({ error: "slug must contain at least one alphanumeric character" }, { status: 400 });
  }

  const existing = getProjects();
  if (existing.some((p) => p.slug === slugClean)) {
    return Response.json({ error: `A project with slug "${slugClean}" already exists` }, { status: 409 });
  }

  const project = {
    slug: slugClean,
    name: name.trim(),
    description: description?.trim() ?? "",
    color: color ?? "#6B7FD4",
    context_keys: Array.isArray(context_keys) ? context_keys.filter(Boolean) : [],
    status: "active",
  };

  const updated = [...existing, project];
  fs.writeFileSync(PROJECTS_PATH, JSON.stringify(updated, null, 2), "utf-8");

  return Response.json({ ok: true, project });
}
