import fs from "fs";
import path from "path";
import { PATHS } from "../../../lib/config";
import { getDecisionsWithAudit } from "../../../lib/decision-write";
import { logContinuityRun, generateRunId } from "../../../lib/run-log";
import type { ContinuityRunRecord } from "../../../lib/run-log";

const MEMORY_DIR = PATHS.memoryDir;
const MEMORY_INDEX = path.join(MEMORY_DIR, "MEMORY.md");

export async function GET(request: Request) {
  const t0 = Date.now();

  const { searchParams } = new URL(request.url);
  const project = searchParams.get("project") ?? undefined;
  const app = searchParams.get("app") ?? undefined;
  const run_id = searchParams.get("run_id") ?? generateRunId();
  const agent = searchParams.get("agent") ?? null;
  const source = searchParams.get("source") ?? null;
  const task_ref = searchParams.get("task_ref") ?? null;

  // Existing flat memory files
  let index = "";
  let files: object[] = [];

  if (fs.existsSync(MEMORY_DIR)) {
    index = fs.existsSync(MEMORY_INDEX)
      ? fs.readFileSync(MEMORY_INDEX, "utf-8")
      : "";

    files = fs
      .readdirSync(MEMORY_DIR)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .map((filename) => {
        const content = fs.readFileSync(path.join(MEMORY_DIR, filename), "utf-8");
        const typeMatch = content.match(/^type:\s*(.+)$/m);
        const nameMatch = content.match(/^name:\s*(.+)$/m);
        const descMatch = content.match(/^description:\s*(.+)$/m);
        return {
          filename,
          type: typeMatch?.[1]?.trim() ?? "unknown",
          name: nameMatch?.[1]?.trim() ?? filename,
          description: descMatch?.[1]?.trim() ?? "",
          content,
        };
      });
  }

  // Active decisions for the requested context, with full audit trail
  const { active: decisions, audit } = getDecisionsWithAudit({ project, app });

  // Shape for injection: lean representation suitable for system prompt use
  const activeDecisions = decisions.map((d) => ({
    id: d.id,
    title: d.title,
    body: d.body,
    rationale: d.rationale || undefined,
    scope: d.scope,
    scope_ref: d.scope_ref || undefined,
    confidence: d.confidence,
    transfer_tier: d.transfer_tier,
    reuse_instructions: d.reuse_instructions || undefined,
    tags: d.tags?.length ? d.tags : undefined,
    context_keys: d.context_keys?.length ? d.context_keys : undefined,
    ratified_by: d.ratified_by || undefined,
    created_at: d.created_at,
  }));

  // Persist run audit record
  const excluded = audit
    .filter((e) => e.result === "excluded")
    .map((e) => ({ id: e.id, title: e.title, reason: e.reason ?? "unknown" }));

  const duration_ms = Date.now() - t0;

  const runRecord: ContinuityRunRecord = {
    run_id,
    ts: new Date().toISOString(),
    project: project ?? null,
    app: app ?? null,
    agent,
    source,
    task_ref,
    injected_ids: decisions.map((d) => d.id),
    excluded,
    injected_count: decisions.length,
    excluded_count: excluded.length,
    total_eligible: audit.length,
    duration_ms,
  };

  logContinuityRun(runRecord);

  return Response.json({ index, files, decisions: activeDecisions, audit, run_id });
}
