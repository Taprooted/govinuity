import fs from "fs";
import os from "os";
import path from "path";
import { getActiveDecisions } from "../../../lib/decision-write";
import { generateAndWrite } from "../../../lib/continuity-file";
import { getProjectBySlug } from "../../../lib/projects";

// Paths the continuity file is allowed to be written under.
// Defaults to the user's home directory — covers ~/.claude, ~/projects, etc.
const ALLOWED_ROOTS = [os.homedir(), os.tmpdir()];

function isSafePath(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return ALLOWED_ROOTS.some((root) => resolved.startsWith(path.resolve(root) + path.sep) || resolved === path.resolve(root));
}

export async function POST(request: Request) {
  const body = await request.json();
  const { output_path, project, agent } = body;

  if (!output_path?.trim()) {
    return Response.json({ error: "output_path is required" }, { status: 400 });
  }

  const targetPath = path.resolve(output_path.trim());

  if (!isSafePath(targetPath)) {
    return Response.json(
      { error: "output_path must be within your home directory or system temp directory" },
      { status: 400 },
    );
  }
  const existed = fs.existsSync(targetPath);

  const projectRecord = project ? getProjectBySlug(project) : undefined;
  const projectName = projectRecord?.name ?? project ?? null;

  const decisions = getActiveDecisions({ project: project ?? undefined });

  try {
    const result = generateAndWrite(decisions, targetPath, {
      project: projectName,
      agent: agent?.trim() ?? "govinuity-ui",
    });
    return Response.json({ ok: true, action: existed ? "updated" : "created", ...result });
  } catch (error) {
    return Response.json(
      { error: String((error as Error).message || error) },
      { status: 500 },
    );
  }
}
