import { getDb, serializeDecisionFields } from "./db";
import { inferProjectFromContext } from "./projects";
import { reviewDecisionProvenance } from "./provenance";
import { normalizeDecisionStatus } from "./utils";
import type { DecisionV2 } from "./utils";

function deriveTitle(body: string): string {
  const first = body.trim().split("\n")[0].trim();
  return first.length > 78 ? first.slice(0, 78) + "…" : first;
}

function deriveSourceType(originalEntry: any): "review" | "direct" | "agent" | "import" {
  const src = originalEntry?.source ?? "";
  if (src === "govinuity" || src === "direct") return "direct";
  if (src && src !== "") return "agent";
  return "import";
}

export function applyReviewDecision({
  id,
  decision,
  note,
  reviewedBy = "user",
}: {
  id: string;
  decision: string;
  note?: string;
  reviewedBy?: string;
}) {
  const db = getDb();
  const normalizedStatus = normalizeDecisionStatus(decision) ?? decision;
  const now = new Date().toISOString();

  return db.transaction(() => {
    const row = db.prepare(
      "SELECT * FROM review_queue WHERE id = ? AND reviewed = 0"
    ).get(id) as Record<string, any> | undefined;

    if (!row) throw new Error("Review item not found");

    const originalEntry = typeof row.original_entry === "string"
      ? JSON.parse(row.original_entry)
      : row.original_entry;

    const project = row.project ?? inferProjectFromContext(originalEntry?.context);
    const body: string = (originalEntry.body ?? "").trim();
    const provenance = reviewDecisionProvenance(originalEntry.id, now);

    // Mark queue item as reviewed
    db.prepare(`
      UPDATE review_queue
      SET reviewed = 1, decision = ?, note = ?, reviewed_at = ?, reviewed_by = ?, follow_up_state = 'open'
      WHERE id = ?
    `).run(normalizedStatus, note ?? null, now, reviewedBy, id);

    // Build the decision entry
    const decisionEntry: DecisionV2 & { decision: string; proposal: string; ts: string } = {
      id: originalEntry.id,
      project_id: project ?? null,
      title: deriveTitle(body),
      body,
      rationale: "",
      source_type: "review",
      source_id: originalEntry.id,
      source_agent: deriveSourceType(originalEntry) === "agent" ? (originalEntry.source ?? null) : null,
      source_loop: originalEntry.loop_id ?? null,
      ratified_by: reviewedBy,
      created_at: now,
      updated_at: now,
      status: normalizedStatus as DecisionV2["status"],
      scope: project ? "project" : "global",
      scope_ref: project ?? null,
      confidence: 0.8,
      transfer_tier: project ? "by_project" : "always",
      effective_until: null,
      review_after: null,
      supersedes: [],
      superseded_by: null,
      related_objects: [],
      assumptions: [],
      revisit_trigger: null,
      reuse_instructions: null,
      provenance,
      tags: [],
      context_keys: project ? [`project:${project}`] : [],
      note: note ?? null,
      follow_up_state: "open",
      // Legacy compat fields
      decision: normalizedStatus,
      proposal: body,
      ts: now,
    };

    const serialized = serializeDecisionFields(decisionEntry as unknown as Record<string, unknown>);

    db.prepare(`
      INSERT OR REPLACE INTO decisions (
        id, project_id, title, body, rationale, status, scope, scope_ref,
        transfer_tier, confidence, ratified_by, created_at, updated_at,
        review_after, effective_until, supersedes, superseded_by, follow_up_state,
        reuse_instructions, revisit_trigger, note, tags, context_keys, assumptions,
        source_type, source_agent, source_id, source_loop, provenance, related_objects
      ) VALUES (
        @id, @project_id, @title, @body, @rationale, @status, @scope, @scope_ref,
        @transfer_tier, @confidence, @ratified_by, @created_at, @updated_at,
        @review_after, @effective_until, @supersedes, @superseded_by, @follow_up_state,
        @reuse_instructions, @revisit_trigger, @note, @tags, @context_keys, @assumptions,
        @source_type, @source_agent, @source_id, @source_loop, @provenance, @related_objects
      )
    `).run(serialized);

    return { ok: true, decisionEntry };
  })();
}
