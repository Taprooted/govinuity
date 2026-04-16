import { getDb, parseDecisionRow, serializeDecisionFields } from "../../../lib/db";
import { updateDecisionFollowUpState, updateDecisionFields, getExpiringDecisions } from "../../../lib/decision-write";
import { filterByProject, getProjectBySlug, withResolvedProject } from "../../../lib/projects";
import { normalizeDecisionStatus } from "../../../lib/utils";
import type { DecisionScope, TransferTier } from "../../../lib/utils";

// Canonical scopes for new writes. "workspace" is excluded — treated as global at read time
// for backward compat, but should not be produced by new entries.
// "task"/"session"/"agent" remain valid but are not recommended for v0.
const VALID_SCOPES = new Set<DecisionScope>(["global","project","app","task","session","agent"]);
const VALID_TIERS = new Set<TransferTier>(["always","by_project","explicit","history_only","re_ratify"]);
const VALID_WRITE_STATUSES = new Set(["proposed","under_review","approved","rejected","deferred"]);
const VALID_SOURCE_TYPES = new Set(["review", "direct", "agent", "import", "harvest", "manual"]);

function validateIsoDate(value: unknown, field: string): string | null {
  if (value == null) return null; // optional field — absence is fine
  if (typeof value !== "string") return `${field} must be a string`;
  const d = new Date(value);
  if (isNaN(d.getTime())) return `${field} is not a valid ISO date: "${value}"`;
  return null;
}

function validateConfidence(value: unknown): string | null {
  if (value == null) return null;
  const n = Number(value);
  if (isNaN(n) || n < 0 || n > 1) return `confidence must be a number between 0 and 1, got: ${value}`;
  return null;
}

function trimString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeProvenance(value: unknown, sourceType: string) {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    ...raw,
    linkType: trimString(raw.linkType) ?? sourceType,
    derivedFrom: normalizeArray(raw.derivedFrom),
  };
}

function reviewContractIssues(entry: Record<string, any>): string[] {
  const issues: string[] = [];
  const sourceType = entry.source_type;
  const status = entry.status ?? entry.decision;
  const provenance = entry.provenance && typeof entry.provenance === "object" ? entry.provenance : {};
  const strictReviewSource = status === "proposed" && ["harvest", "agent", "import"].includes(sourceType);

  if (strictReviewSource && !trimString(entry.summary_for_human)) issues.push("missing human summary");
  if (strictReviewSource && !trimString(entry.why_surfaced)) {
    issues.push("missing why surfaced");
  }
  if (strictReviewSource && !trimString(entry.proposal_class)) issues.push("missing proposal class");
  if (typeof entry.confidence !== "number" || isNaN(entry.confidence)) issues.push("missing confidence");
  if (!trimString(entry.source_agent) && !trimString(entry.source_type) && !trimString(provenance.linkType)) {
    issues.push("missing source provenance");
  }
  return issues;
}

function normalizeEntry(raw: any) {
  const resolved = withResolvedProject(raw);

  // Normalize status: v2 entries have `status`, v1 entries have `decision`
  const status = resolved.status ?? normalizeDecisionStatus(resolved.decision) ?? resolved.decision;
  const confidence = resolved.confidence == null ? undefined : Number(resolved.confidence);
  const entry = {
    ...resolved,
    confidence: confidence == null || isNaN(confidence) ? resolved.confidence : confidence,
    provenance: normalizeProvenance(resolved.provenance, resolved.source_type ?? "direct"),
  };

  // Always expose both `status` (v2) and `decision` (v1 compat alias) so existing UI keeps working
  const normalized = {
    ...entry,
    status,
    decision: status,
    // Also expose `body` (v2) and `proposal` (v1 compat alias)
    body: entry.body ?? entry.proposal,
    proposal: entry.body ?? entry.proposal,
    // Expose `created_at` (v2) and `ts` (v1 compat alias)
    created_at: entry.created_at ?? entry.ts,
    ts: entry.created_at ?? entry.ts,
    // Synthesize legacy context for UI consumers that still depend on it;
    // v2 entries omit context in storage but scope_ref holds the same value
    context: entry.context ?? entry.scope_ref ?? null,
  };
  const issues = reviewContractIssues(normalized);
  return {
    ...normalized,
    review_contract: {
      issues,
      status: typeof normalized.confidence === "number" && normalized.confidence < 0.6
        ? "low_signal"
        : issues.length > 0
        ? "needs_context"
        : "complete",
    },
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") ?? "50", 10) || 50;
  const context = searchParams.get("context");
  const decision = searchParams.get("decision"); // v1 compat filter
  const status = searchParams.get("status");     // v2 filter
  const projectSlug = searchParams.get("project");

  // Special case: expiring decisions (approved, review_after within N days)
  if (searchParams.get("expiring") === "true") {
    const within = parseInt(searchParams.get("within") ?? "14", 10) || 14;
    const expiring = getExpiringDecisions(within).map(normalizeEntry);
    return Response.json({ entries: expiring, warnings: [] });
  }

  const db = getDb();
  const rawEntries = (db.prepare("SELECT * FROM decisions").all() as Record<string, any>[]).map(parseDecisionRow);
  let entries = rawEntries.map(normalizeEntry);
  const warnings: string[] = [];

  // Legacy: context query param filters by stored `context` field on old entries only
  if (context) entries = entries.filter((e) => e.context === context);

  const statusFilter = status ?? decision;
  if (statusFilter) entries = entries.filter((e) => e.status === statusFilter || e.decision === statusFilter);

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
  const body = await request.json();

  // Accept both `status` (v2) and `decision` (v1 compat) in the request body
  const statusRaw = body.status ?? body.decision;
  const { proposal, context, project, source, note, ratified_by } = body;

  // `proposal` is the v1 alias; `body` is the v2 field — accept either
  const bodyText: string = (body.body ?? proposal ?? "").trim();

  if (!bodyText || !statusRaw) {
    return Response.json({ error: "body (or proposal) and status (or decision) are required" }, { status: 400 });
  }

  const normalizedStatus = normalizeDecisionStatus(statusRaw) ?? statusRaw;
  if (!VALID_WRITE_STATUSES.has(normalizedStatus)) {
    return Response.json({ error: `status must be one of: ${[...VALID_WRITE_STATUSES].join(", ")}` }, { status: 400 });
  }

  // Authority guard
  if (normalizedStatus === "approved" && !ratified_by?.trim()) {
    return Response.json(
      { error: "approved decisions require ratified_by — set status=proposed for unratified entries" },
      { status: 400 },
    );
  }

  // Structural validation
  const scopeValue = body.scope ?? (project ? "project" : "global");
  if (!VALID_SCOPES.has(scopeValue)) {
    return Response.json({ error: `scope must be one of: ${[...VALID_SCOPES].join(", ")}` }, { status: 400 });
  }
  const tierValue = body.transfer_tier ?? (project ? "by_project" : "always");
  if (!VALID_TIERS.has(tierValue)) {
    return Response.json({ error: `transfer_tier must be one of: ${[...VALID_TIERS].join(", ")}` }, { status: 400 });
  }
  const confErr = validateConfidence(body.confidence);
  if (confErr) return Response.json({ error: confErr }, { status: 400 });
  const euErr = validateIsoDate(body.effective_until, "effective_until");
  if (euErr) return Response.json({ error: euErr }, { status: 400 });
  const raErr = validateIsoDate(body.review_after, "review_after");
  if (raErr) return Response.json({ error: raErr }, { status: 400 });

  const now = new Date().toISOString();
  const titleRaw = (body.title?.trim() || bodyText.split("\n")[0]).trim();
  const title = titleRaw.length > 120 ? titleRaw.slice(0, 120) + "…" : titleRaw;
  const requestedSourceType = body.source_type ?? (source === "harvest" ? "harvest" : "direct");
  const sourceType = VALID_SOURCE_TYPES.has(requestedSourceType) ? requestedSourceType : "direct";
  const confidenceValue = body.confidence == null ? 0.8 : Number(body.confidence);
  const provenance = normalizeProvenance(body.provenance, sourceType);

  const entry: Record<string, unknown> = {
    id: `dec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    project_id: project ?? null,
    title,
    body: bodyText,
    rationale: trimString(body.rationale) ?? "",
    source_type: sourceType,
    source_id: trimString(body.source_id),
    source_agent: trimString(body.source_agent) ?? trimString(source),
    source_loop: null,
    ratified_by: normalizedStatus === "approved" ? (ratified_by?.trim() ?? null) : null,
    created_at: now,
    updated_at: now,
    status: normalizedStatus,
    scope: scopeValue,
    scope_ref: body.scope_ref ?? project ?? null,
    confidence: confidenceValue,
    transfer_tier: tierValue,
    effective_until: body.effective_until ?? null,
    review_after: body.review_after ?? null,
    supersedes: normalizeArray(body.supersedes),
    superseded_by: null,
    related_objects: normalizeArray(body.related_objects),
    assumptions: normalizeArray(body.assumptions),
    revisit_trigger: trimString(body.revisit_trigger),
    reuse_instructions: trimString(body.reuse_instructions),
    provenance,
    tags: normalizeArray(body.tags),
    context_keys: Array.isArray(body.context_keys) ? body.context_keys : (project ? [`project:${project}`] : []),
    note: note?.trim() ?? null,
    // Governance / harvest fields
    summary_for_human: trimString(body.summary_for_human),
    why_surfaced: trimString(body.why_surfaced),
    reversibility: ["low", "medium", "high"].includes(body.reversibility) ? body.reversibility : null,
    possible_conflicts: normalizeArray(body.possible_conflicts),
    proposal_class: trimString(body.proposal_class),
    // Legacy read-compat aliases — do not write new logic against these
    decision: normalizedStatus,
    proposal: bodyText,
    ts: now,
    follow_up_state: "open",
  };

  // PHASE1_SHIM: write context only if provided — not required for new writes
  if (context?.trim()) entry.context = context.trim();
  // Ensure context is always present for the INSERT (nullable column)
  if (!("context" in entry)) entry.context = null;

  const db = getDb();
  const serialized = serializeDecisionFields(entry);
  db.prepare(`
    INSERT INTO decisions (
      id, project_id, title, body, rationale, source_type, source_id, source_agent, source_loop,
      ratified_by, created_at, updated_at, status, scope, scope_ref, confidence, transfer_tier,
      effective_until, review_after, supersedes, superseded_by, related_objects, assumptions,
      revisit_trigger, reuse_instructions, provenance, tags, context_keys, note,
      summary_for_human, why_surfaced, reversibility, possible_conflicts, proposal_class,
      follow_up_state, context
    ) VALUES (
      @id, @project_id, @title, @body, @rationale, @source_type, @source_id, @source_agent, @source_loop,
      @ratified_by, @created_at, @updated_at, @status, @scope, @scope_ref, @confidence, @transfer_tier,
      @effective_until, @review_after, @supersedes, @superseded_by, @related_objects, @assumptions,
      @revisit_trigger, @reuse_instructions, @provenance, @tags, @context_keys, @note,
      @summary_for_human, @why_surfaced, @reversibility, @possible_conflicts, @proposal_class,
      @follow_up_state, @context
    )
  `).run(serialized);
  const normalizedEntry = normalizeEntry(entry);
  return Response.json({
    ok: true,
    entry: normalizedEntry,
    warnings: normalizedEntry.review_contract?.issues ?? [],
  });
}

export async function PATCH(request: Request) {
  const body = await request.json();
  const { id, ts } = body;

  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }

  // Status transition (proposed → approved / rejected / deferred)
  if (body.status !== undefined) {
    const newStatus: string = body.status;
    if (!VALID_WRITE_STATUSES.has(newStatus)) {
      return Response.json({ error: `status must be one of: ${[...VALID_WRITE_STATUSES].join(", ")}` }, { status: 400 });
    }
    if (newStatus === "approved" && !body.ratified_by?.trim()) {
      return Response.json({ error: "approved decisions require ratified_by" }, { status: 400 });
    }
    try {
      const fields: Record<string, unknown> = { status: newStatus };
      if (newStatus === "approved") fields.ratified_by = body.ratified_by.trim();
      const result = updateDecisionFields({ id, ts, fields });
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: String((error as Error).message || error) }, { status: 500 });
    }
  }

  // follow_up_state update (existing behaviour)
  if (body.follow_up_state !== undefined) {
    if (!["open", "resolved"].includes(body.follow_up_state)) {
      return Response.json({ error: "follow_up_state must be 'open' or 'resolved'" }, { status: 400 });
    }
    try {
      const result = updateDecisionFollowUpState({ id, ts, followUpState: body.follow_up_state });
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: String((error as Error).message || error) }, { status: 500 });
    }
  }

  // Renewal / field update (review_after, confidence, transfer_tier, reuse_instructions)
  const updatable = ["review_after", "confidence", "transfer_tier", "reuse_instructions", "revisit_trigger", "note"];
  const fields: Record<string, unknown> = {};
  for (const key of updatable) {
    if (body[key] !== undefined) fields[key] = body[key];
  }

  if (Object.keys(fields).length === 0) {
    return Response.json({ error: "no updatable fields provided" }, { status: 400 });
  }

  const confErr2 = validateConfidence(fields.confidence);
  if (confErr2) return Response.json({ error: confErr2 }, { status: 400 });
  if (fields.confidence !== undefined) fields.confidence = Number(fields.confidence);

  if (fields.transfer_tier !== undefined && !VALID_TIERS.has(fields.transfer_tier as TransferTier)) {
    return Response.json({ error: `transfer_tier must be one of: ${[...VALID_TIERS].join(", ")}` }, { status: 400 });
  }

  const raErr2 = validateIsoDate(fields.review_after, "review_after");
  if (raErr2) return Response.json({ error: raErr2 }, { status: 400 });

  try {
    const result = updateDecisionFields({ id, ts, fields });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: String((error as Error).message || error) }, { status: 500 });
  }
}
