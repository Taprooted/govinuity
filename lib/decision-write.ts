import { getDb, parseDecisionRow, serializeDecisionFields } from "./db";
import { computeEligibilityWithReason } from "./utils";
import type { DecisionV2, InjectionContext } from "./utils";

export type InjectionAuditEntry = {
  id: string;
  title: string;
  result: "injected" | "excluded";
  reason?: string;
};

const SUPERSEDABLE_STATUSES = new Set(["approved", "deferred"]);

// ─── Read: active decisions ────────────────────────────────────────────────

/**
 * Returns active decisions with a full audit trail explaining every inclusion
 * and exclusion. Conflict resolution is applied: if two eligible decisions
 * have a declared conflict with each other, only the more recently ratified
 * one is injected; the other is excluded with reason="unresolved_conflict".
 */
export function getDecisionsWithAudit(ctx: InjectionContext = {}): {
  active: DecisionV2[];
  audit: InjectionAuditEntry[];
} {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM decisions WHERE status = 'approved' AND (superseded_by IS NULL OR superseded_by = '') ORDER BY created_at ASC`)
    .all() as Record<string, unknown>[];

  const audit: InjectionAuditEntry[] = [];
  const eligible: DecisionV2[] = [];

  // Pass 1: individual eligibility
  for (const raw of rows) {
    const d = parseDecisionRow(raw) as DecisionV2;
    const result = computeEligibilityWithReason(d, ctx);
    if (result.eligible) {
      eligible.push(d);
    } else {
      const excReason = (result as { eligible: false; reason: string }).reason;
      audit.push({ id: d.id, title: d.title || d.id, result: "excluded", reason: excReason });
    }
  }

  // Pass 2: conflict resolution
  const conflicted = new Set<string>();

  for (let i = 0; i < eligible.length; i++) {
    if (conflicted.has(eligible[i].id)) continue;
    const a = eligible[i];
    const rawConflicts = (a as any).possible_conflicts;
    const conflicts: unknown[] = Array.isArray(rawConflicts) ? rawConflicts : [];
    if (conflicts.length === 0) continue;

    const conflictTexts = conflicts
      .map((c) => (typeof c === "string" ? c : ((c as any).title ?? "")).toLowerCase())
      .filter(Boolean);

    for (let j = i + 1; j < eligible.length; j++) {
      if (conflicted.has(eligible[j].id)) continue;
      const b = eligible[j];
      const bWords = new Set((b.title || "").toLowerCase().split(/\s+/).filter((w: string) => w.length > 3));

      const hasConflict = conflictTexts.some((ct: string) => {
        const ctWords = new Set(ct.split(/\s+/).filter((w: string) => w.length > 3));
        if (ctWords.size === 0) return false;
        const overlap = [...ctWords].filter((w) => bWords.has(w)).length;
        return overlap / ctWords.size >= 0.5;
      });

      if (hasConflict) {
        const aDate = new Date((a as any).created_at || 0).getTime();
        const bDate = new Date((b as any).created_at || 0).getTime();
        const [keepId, excludeId] = aDate >= bDate ? [a.id, b.id] : [b.id, a.id];
        conflicted.add(excludeId);
        const excluded = eligible.find((d) => d.id === excludeId)!;
        audit.push({
          id: excludeId,
          title: excluded.title || excludeId,
          result: "excluded",
          reason: `unresolved_conflict:${keepId}`,
        });
      }
    }
  }

  const active = eligible.filter((d) => !conflicted.has(d.id));
  active.forEach((d) => audit.push({ id: d.id, title: d.title || d.id, result: "injected" }));

  return { active, audit };
}

/** Return all decisions currently eligible for active memory injection. */
export function getActiveDecisions(ctx: InjectionContext = {}): DecisionV2[] {
  return getDecisionsWithAudit(ctx).active;
}

/** Return approved decisions whose review_after falls within the next `daysAhead` days. */
export function getExpiringDecisions(daysAhead = 14): DecisionV2[] {
  const db = getDb();
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(`SELECT * FROM decisions WHERE status = 'approved' AND superseded_by IS NULL AND review_after > ? AND review_after <= ? ORDER BY review_after ASC`)
    .all(now, cutoff) as Record<string, unknown>[];
  return rows.map((r) => parseDecisionRow(r) as DecisionV2);
}

/** Return all approved decisions that are stale (review_after has elapsed). */
export function getStaleDecisions(projectId?: string): DecisionV2[] {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = (
    projectId
      ? db.prepare(`SELECT * FROM decisions WHERE status = 'approved' AND superseded_by IS NULL AND review_after IS NOT NULL AND review_after < ? AND project_id = ?`).all(now, projectId)
      : db.prepare(`SELECT * FROM decisions WHERE status = 'approved' AND superseded_by IS NULL AND review_after IS NOT NULL AND review_after < ?`).all(now)
  ) as Record<string, unknown>[];
  return rows.map((r) => parseDecisionRow(r) as DecisionV2);
}

/**
 * Query all decisions for the API layer — returns raw parsed rows, no eligibility filtering.
 * The `status` filter accepts a single status value (e.g. "approved", "deferred").
 */
export function queryAllDecisions(filters: {
  status?: string;
  context?: string;
  limit?: number;
}): { entries: Record<string, unknown>[]; warnings: string[] } {
  const db = getDb();
  let sql = "SELECT * FROM decisions";
  const params: unknown[] = [];
  const where: string[] = [];

  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  if (filters.context) {
    // Legacy: match stored context field
    where.push("context = ?");
    params.push(filters.context);
  }
  if (where.length > 0) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at ASC";

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  const parsed = rows.map(parseDecisionRow);

  const limit = filters.limit ?? 50;
  const recent = parsed.slice(-limit).reverse();
  return { entries: recent, warnings: [] };
}

// ─── Write: insert / update ────────────────────────────────────────────────

/**
 * Insert a new decision into the database.
 * Accepts the full entry object as produced by the POST route or review-write.
 */
export function insertDecision(entry: Record<string, unknown>): void {
  const db = getDb();
  const row = serializeDecisionFields(entry);

  db.prepare(`
    INSERT OR REPLACE INTO decisions (
      id, project_id, title, body, rationale, status, scope, scope_ref,
      transfer_tier, confidence, ratified_by, created_at, updated_at,
      review_after, effective_until, supersedes, superseded_by, follow_up_state,
      proposal_class, summary_for_human, why_surfaced, reversibility,
      possible_conflicts, reuse_instructions, revisit_trigger, note,
      tags, context_keys, assumptions, source_type, source_agent, source_id,
      source_loop, provenance, related_objects, context
    ) VALUES (
      @id, @project_id, @title, @body, @rationale, @status, @scope, @scope_ref,
      @transfer_tier, @confidence, @ratified_by, @created_at, @updated_at,
      @review_after, @effective_until, @supersedes, @superseded_by, @follow_up_state,
      @proposal_class, @summary_for_human, @why_surfaced, @reversibility,
      @possible_conflicts, @reuse_instructions, @revisit_trigger, @note,
      @tags, @context_keys, @assumptions, @source_type, @source_agent, @source_id,
      @source_loop, @provenance, @related_objects, @context
    )
  `).run({
    id: row.id ?? null,
    project_id: row.project_id ?? null,
    title: row.title ?? null,
    body: row.body ?? "",
    rationale: row.rationale ?? null,
    status: row.status ?? "proposed",
    scope: row.scope ?? "global",
    scope_ref: row.scope_ref ?? null,
    transfer_tier: row.transfer_tier ?? "always",
    confidence: row.confidence ?? 0.8,
    ratified_by: row.ratified_by ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    review_after: row.review_after ?? null,
    effective_until: row.effective_until ?? null,
    supersedes: row.supersedes ?? "[]",
    superseded_by: row.superseded_by ?? null,
    follow_up_state: row.follow_up_state ?? "open",
    proposal_class: row.proposal_class ?? null,
    summary_for_human: row.summary_for_human ?? null,
    why_surfaced: row.why_surfaced ?? null,
    reversibility: row.reversibility ?? null,
    possible_conflicts: row.possible_conflicts ?? "[]",
    reuse_instructions: row.reuse_instructions ?? null,
    revisit_trigger: row.revisit_trigger ?? null,
    note: row.note ?? null,
    tags: row.tags ?? "[]",
    context_keys: row.context_keys ?? "[]",
    assumptions: row.assumptions ?? "[]",
    source_type: row.source_type ?? null,
    source_agent: row.source_agent ?? null,
    source_id: row.source_id ?? null,
    source_loop: row.source_loop ?? null,
    provenance: row.provenance ?? "{}",
    related_objects: row.related_objects ?? "[]",
    context: row.context ?? null,
  });
}

export function updateDecisionFollowUpState({
  id,
  followUpState,
}: {
  id: string;
  ts?: string;
  followUpState: "open" | "resolved";
}) {
  const db = getDb();
  const info = db
    .prepare("UPDATE decisions SET follow_up_state = ?, updated_at = ? WHERE id = ?")
    .run(followUpState, new Date().toISOString(), id);
  if (info.changes === 0) throw new Error("Decision not found");
  return { ok: true, id, followUpState };
}

/**
 * Update one or more mutable fields on an existing decision.
 * Immutable fields (id, body, ratified_by, created_at, supersedes, superseded_by) are not accepted.
 */
export function updateDecisionFields({
  id,
  fields,
}: {
  id: string;
  ts?: string;
  fields: Record<string, unknown>;
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const serialized = serializeDecisionFields(fields);

  const setClauses = [...Object.keys(serialized).map((k) => `${k} = @${k}`), "updated_at = @updated_at"].join(", ");
  const info = db
    .prepare(`UPDATE decisions SET ${setClauses} WHERE id = @id`)
    .run({ ...serialized, updated_at: now, id });

  if (info.changes === 0) throw new Error("Decision not found");
  return { ok: true, id, updated: Object.keys(fields) };
}

/**
 * Atomically write a new decision that supersedes one or more existing decisions.
 */
export function supersede(newDecision: DecisionV2): { ok: true; newDecision: DecisionV2; supersededIds: string[] } {
  if (newDecision.status !== "approved") {
    throw new Error(`supersede() requires newDecision.status === "approved", got "${newDecision.status}"`);
  }
  if (!newDecision.ratified_by?.trim()) {
    throw new Error("supersede() requires newDecision.ratified_by");
  }
  const supersededIds = newDecision.supersedes;
  if (!Array.isArray(supersededIds) || supersededIds.length === 0) {
    throw new Error("supersede() requires at least one ID in newDecision.supersedes");
  }
  const uniqueIds = new Set(supersededIds);
  if (uniqueIds.size !== supersededIds.length) {
    const dupes = supersededIds.filter((id, i) => supersededIds.indexOf(id) !== i);
    throw new Error(`supersede() received duplicate IDs: ${[...new Set(dupes)].join(", ")}`);
  }
  if (supersededIds.includes(newDecision.id)) {
    throw new Error(`supersede() cannot self-supersede`);
  }

  const db = getDb();
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    // Validate all targets
    for (const targetId of supersededIds) {
      const target = db.prepare("SELECT id, status, superseded_by FROM decisions WHERE id = ?").get(targetId) as any;
      if (!target) throw new Error(`Decision not found: ${targetId}`);
      if (!SUPERSEDABLE_STATUSES.has(target.status ?? "")) {
        throw new Error(`Decision "${targetId}" has status "${target.status}" and cannot be superseded.`);
      }
      if (target.superseded_by != null && target.superseded_by !== "") {
        throw new Error(`Decision "${targetId}" is already superseded by "${target.superseded_by}".`);
      }
    }

    // Insert new decision
    insertDecision({ ...(newDecision as unknown as Record<string, unknown>), created_at: now, updated_at: now });

    // Mark targets as superseded
    const markStmt = db.prepare(
      "UPDATE decisions SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?"
    );
    for (const targetId of supersededIds) {
      markStmt.run(newDecision.id, now, targetId);
    }
  });

  txn();
  return { ok: true, newDecision, supersededIds };
}
