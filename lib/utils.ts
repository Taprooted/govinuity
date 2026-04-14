// v1 compat narrow type — kept for normalizeDecisionStatus return signature
export type DecisionStatusLegacy = "approved" | "rejected" | "deferred";

// v2 full governance lifecycle
export type DecisionStatus =
  | "proposed"
  | "under_review"
  | "approved"
  | "rejected"
  | "deferred"
  | "superseded"
  | "archived";

export type DecisionScope =
  | "global"
  | "workspace"
  | "project"
  | "app"
  | "task"
  | "session"
  | "agent";

export type TransferTier =
  | "always"
  | "by_project"
  | "explicit"
  | "history_only"
  | "re_ratify";

export type RelatedObject = {
  type: "artifact" | "loop" | "feedback" | "decision" | "review";
  id: string;
  rel: "derives_from" | "informs" | "constrains" | "supersedes" | "cites";
};

import type { CompactProvenance } from "./provenance";
export type { CompactProvenance };

export type DecisionV2 = {
  // Identity
  id: string;
  project_id: string | null;
  title: string;
  body: string;
  rationale: string;
  // Provenance
  source_type: "review" | "direct" | "agent" | "import";
  source_id: string | null;
  source_agent: string | null;
  source_loop: string | null;
  // Governance
  ratified_by: string | null;
  created_at: string;
  updated_at: string;
  status: DecisionStatus;
  // Scope
  scope: DecisionScope;
  scope_ref: string | null;
  // Memory / transfer
  confidence: number;
  transfer_tier: TransferTier;
  effective_until: string | null;
  review_after: string | null;
  // Supersession
  supersedes: string[];
  superseded_by: string | null;
  // Relationships
  related_objects: RelatedObject[];
  assumptions: string[];
  revisit_trigger: string | null;
  reuse_instructions: string | null;
  // Context
  provenance: CompactProvenance;
  tags: string[];
  context_keys: string[];
  note: string | null;
  // Legacy compat
  follow_up_state?: "open" | "resolved";
  // PHASE1_SHIM: remove in Phase 2 — replaced by scope + scope_ref + context_keys
  context?: string;
};

export type InjectionContext = {
  project?: string;
  app?: string;
  task?: string;
  session?: string;
  agent?: string;
  workspace?: string; // reserved for future multi-workspace support; currently unused in matching
  now?: Date;
  explicit?: boolean; // set true when caller explicitly requests injection of "explicit" tier decisions
};

const VALID_STATUSES = new Set<DecisionStatus>([
  "proposed", "under_review", "approved", "rejected", "deferred", "superseded", "archived",
]);

const VALID_TRANSFER_TIERS = new Set<TransferTier>([
  "always", "by_project", "explicit", "history_only", "re_ratify",
]);

function isValidIsoDate(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime());
}

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: string };

/**
 * Returns eligibility with a machine-readable exclusion reason.
 * Used by the injection audit trail and conflict resolution logic.
 * Fail-closed: any structural anomaly returns eligible=false.
 */
export function computeEligibilityWithReason(
  decision: DecisionV2,
  ctx: InjectionContext = {},
): EligibilityResult {
  if (!decision || typeof decision !== "object")
    return { eligible: false, reason: "invalid_object" };
  if (!decision.status || !VALID_STATUSES.has(decision.status))
    return { eligible: false, reason: "invalid_status" };
  if (typeof decision.confidence !== "number" || isNaN(decision.confidence) || decision.confidence < 0 || decision.confidence > 1)
    return { eligible: false, reason: "invalid_confidence" };
  if (!decision.transfer_tier || !VALID_TRANSFER_TIERS.has(decision.transfer_tier))
    return { eligible: false, reason: "invalid_tier" };

  const now = ctx.now ?? new Date();

  if (decision.status !== "approved")
    return { eligible: false, reason: `status:${decision.status}` };
  if (decision.superseded_by != null && decision.superseded_by !== "")
    return { eligible: false, reason: `superseded_by:${decision.superseded_by}` };

  if (decision.transfer_tier === "history_only" || decision.transfer_tier === "re_ratify")
    return { eligible: false, reason: `tier:${decision.transfer_tier}` };
  if (decision.transfer_tier === "explicit" && !ctx.explicit)
    return { eligible: false, reason: "tier:explicit_not_requested" };

  if (decision.confidence < 0.6)
    return { eligible: false, reason: `confidence_below_threshold:${decision.confidence}` };

  if (decision.effective_until != null) {
    if (!isValidIsoDate(decision.effective_until))
      return { eligible: false, reason: "invalid_effective_until" };
    if (new Date(decision.effective_until) <= now)
      return { eligible: false, reason: "expired:effective_until" };
  }
  if (decision.review_after != null) {
    if (!isValidIsoDate(decision.review_after))
      return { eligible: false, reason: "invalid_review_after" };
    if (new Date(decision.review_after) <= now)
      return { eligible: false, reason: "stale:review_after_elapsed" };
  }

  // Scope matching — fail closed on unknown scope
  switch (decision.scope) {
    case "global":
      return { eligible: true };
    case "workspace":
      // Treated as global for now; ctx.workspace reserved for future multi-workspace use
      return { eligible: true };
    case "project":
      if (typeof ctx.project !== "string" || ctx.project === "" || ctx.project !== decision.scope_ref)
        return { eligible: false, reason: `scope:project_mismatch ctx=${ctx.project ?? "none"} ref=${decision.scope_ref ?? "none"}` };
      return { eligible: true };
    case "app":
      if (typeof ctx.app !== "string" || ctx.app === "" || ctx.app !== decision.scope_ref)
        return { eligible: false, reason: `scope:app_mismatch` };
      return { eligible: true };
    case "task":
      if (typeof ctx.task !== "string" || ctx.task === "" || ctx.task !== decision.scope_ref)
        return { eligible: false, reason: `scope:task_mismatch` };
      return { eligible: true };
    case "session":
      if (typeof ctx.session !== "string" || ctx.session === "" || ctx.session !== decision.scope_ref)
        return { eligible: false, reason: `scope:session_mismatch` };
      return { eligible: true };
    case "agent":
      if (typeof ctx.agent !== "string" || ctx.agent === "" || ctx.agent !== decision.scope_ref)
        return { eligible: false, reason: `scope:agent_mismatch` };
      return { eligible: true };
    default:
      return { eligible: false, reason: `scope:unknown(${decision.scope})` };
  }
}

/** Backward-compat wrapper — returns boolean only. */
export function computeActiveEligibility(decision: DecisionV2, ctx: InjectionContext = {}): boolean {
  return computeEligibilityWithReason(decision, ctx).eligible;
}

export function timeAgo(ts: string | null | undefined) {
  if (!ts) return "—";
  const diff = Date.now() - new Date(ts).getTime();
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  const m = Math.floor(diff / 60000);
  if (m > 0) return `${m}m ago`;
  return "just now";
}

export function normalizeDecisionStatus(value: string | null | undefined): DecisionStatusLegacy | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "approve" || lower === "approved") return "approved";
  if (lower === "reject" || lower === "rejected") return "rejected";
  if (lower === "defer" || lower === "deferred") return "deferred";
  return null;
}

export function toneForDecision(value: string | null | undefined) {
  const v = value?.toLowerCase();
  if (v === "approved" || v === "approve") return "success" as const;
  if (v === "rejected" || v === "reject") return "danger" as const;
  if (v === "deferred" || v === "defer") return "warning" as const;
  if (v === "superseded") return "neutral" as const;
  if (v === "archived") return "neutral" as const;
  if (v === "proposed" || v === "under_review") return "warning" as const;
  return "neutral" as const;
}

export function decisionLabel(value: string | null | undefined) {
  return normalizeDecisionStatus(value) ?? value ?? "—";
}
