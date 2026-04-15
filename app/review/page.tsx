"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard, StackedBar, StatusBadge } from "../components/ui";
import { directDecisionLink, contextRelated, inferTextRelation } from "../../lib/relations";
import { timeAgo, toneForDecision } from "../../lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

type ProposedDecision = {
  id: string;
  ts: string;
  title?: string;
  body: string;
  rationale?: string;
  scope?: string;
  scope_ref?: string;
  confidence?: number;
  context?: string;
  provenance?: { task_id?: string };
  // Governance fields (v2 — may be absent on older proposals)
  summary_for_human?: string;
  why_surfaced?: string;
  reversibility?: "low" | "medium" | "high";
  possible_conflicts?: Array<{ id: string; title: string } | string>;
  proposal_class?: string;
};

type ReviewItem = {
  ts: string;
  reviewed: boolean;
  decision?: string;
  note?: string;
  reviewed_at?: string;
  original_entry: {
    id: string;
    source: string;
    type: string;
    context: string;
    body: string;
    severity: string;
  };
};

type DecisionEntry = {
  ts: string;
  id: string;
  decision: string;
  proposal: string;
  source: string;
  context: string;
  note?: string;
  title?: string;
};

type FeedbackEntry = {
  id: string;
  ts: string;
  source: string;
  type: string;
  context: string;
  body: string;
  severity: string;
  loop_id?: string;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function reversibilityBorder(r?: "low" | "medium" | "high") {
  if (r === "low") return "border-l-2 border-l-amber-700/70";
  return "";
}

function reversibilityLabel(r?: "low" | "medium" | "high") {
  if (!r) return null;
  const map = {
    low:    { text: "hard to reverse",        color: "text-amber-400", dot: "bg-amber-500" },
    medium: { text: "moderately reversible",  color: "text-[var(--muted)]", dot: "bg-zinc-500" },
    high:   { text: "easy to revise",         color: "text-emerald-500", dot: "bg-emerald-600" },
  };
  return map[r];
}

const CLASS_LABELS: Record<string, string> = {
  // Canonical classes
  architectural_decision: "architecture",
  durable_workflow_rule:  "workflow",
  scoped_exception:       "exception",
  durable_constraint:     "constraint",
  // Legacy aliases — kept for existing proposals
  workflow_rule:              "workflow",
  scoped_implementation_rule: "implementation",
  release_or_ops_config:      "ops/config",
  personal_profile:           "profile",
  local_exception:            "exception",
  exploratory_direction:      "exploration",
  ephemeral_note:             "temporary",
};

function conflictList(conflicts?: ProposedDecision["possible_conflicts"]): string[] {
  if (!conflicts || conflicts.length === 0) return [];
  return conflicts.map((c) => (typeof c === "string" ? c : c.title ?? c.id));
}

function reversibilityRank(r?: "low" | "medium" | "high") {
  if (r === "low") return 0;
  if (r === "medium") return 1;
  return 2;
}

// Sort by review risk: hard-to-reverse proposals first, then conflicts, then confidence.
function sortProposals(proposals: ProposedDecision[]): ProposedDecision[] {
  return [...proposals].sort((a, b) => {
    const rA = reversibilityRank(a.reversibility);
    const rB = reversibilityRank(b.reversibility);
    if (rA !== rB) return rA - rB;
    const cA = conflictList(a.possible_conflicts).length > 0 ? 0 : 1;
    const cB = conflictList(b.possible_conflicts).length > 0 ? 0 : 1;
    if (cA !== cB) return cA - cB;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const [proposals, setProposals] = useState<ProposedDecision[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [proposalActing, setProposalActing] = useState<string | null>(null);
  const [detailExpanded, setDetailExpanded] = useState(false);

  const [items, setItems] = useState<ReviewItem[]>([]);
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"pending" | "reviewed" | "all">("pending");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const [reviewRes, decisionsRes, feedbackRes, proposalsRes] = await Promise.all([
        fetch("/api/review-queue").then((r) => r.json()),
        fetch("/api/decisions?limit=200").then((r) => r.json()),
        fetch("/api/feedback?limit=100").then((r) => r.json()),
        fetch("/api/decisions?status=proposed&limit=100").then((r) => r.json()),
      ]);
      setItems(reviewRes.items ?? []);
      setDecisions(decisionsRes.entries ?? []);
      setFeedback(feedbackRes.entries ?? []);
      const sorted = sortProposals(proposalsRes.entries ?? []);
      setProposals(sorted);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load review data");
    } finally {
      setLoading(false);
    }
  }

  // Auto-select first proposal
  useEffect(() => {
    if (proposals.length > 0 && !selectedProposalId) {
      setSelectedProposalId(proposals[0].id);
    }
  }, [proposals]);

  async function actOnProposal(id: string, status: "approved" | "rejected" | "deferred") {
    setProposalActing(id);
    await fetch("/api/decisions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status, ratified_by: status === "approved" ? "govinuity-review" : undefined }),
    });
    setProposalActing(null);
    // Advance to next proposal
    const idx = proposals.findIndex((p) => p.id === id);
    const next = proposals[idx + 1] ?? proposals[idx - 1] ?? null;
    setSelectedProposalId(next?.id ?? null);
    await load();
  }

  useEffect(() => { load(); }, []);

  // Keyboard shortcuts for proposals
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

      const idx = proposals.findIndex((p) => p.id === selectedProposalId);

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = proposals[idx + 1];
        if (next) { setSelectedProposalId(next.id); setDetailExpanded(false); }
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = proposals[idx - 1];
        if (prev) { setSelectedProposalId(prev.id); setDetailExpanded(false); }
      } else if (e.key === "Enter" && selectedProposalId && !proposalActing) {
        e.preventDefault();
        actOnProposal(selectedProposalId, "approved");
      } else if (e.key === "d" && selectedProposalId && !proposalActing) {
        e.preventDefault();
        actOnProposal(selectedProposalId, "deferred");
      } else if (e.key === "x" && selectedProposalId && !proposalActing) {
        e.preventDefault();
        actOnProposal(selectedProposalId, "rejected");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [proposals, selectedProposalId, proposalActing]);

  const selectedProposal = proposals.find((p) => p.id === selectedProposalId) ?? null;

  // Related decisions for selected proposal
  const relatedDecisions = useMemo(() => {
    if (!selectedProposal) return [];
    const context = selectedProposal.context ?? selectedProposal.scope_ref ?? "";
    return decisions
      .filter((d) => d.decision === "approved" && context && d.context?.includes(context.split(":")[0]))
      .slice(0, 4);
  }, [selectedProposal, decisions]);

  // Review queue
  async function decide(id: string, decision: string) {
    setSubmitting(true);
    await fetch("/api/review-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, decision, note: note || undefined }),
    });
    setActiveId(null);
    setNote("");
    setSubmitting(false);
    await load();
  }

  const filtered = items.filter((item) => {
    if (filter === "pending" && item.reviewed) return false;
    if (filter === "reviewed" && !item.reviewed) return false;
    return true;
  });

  const pendingCount = items.filter((i) => !i.reviewed).length;
  const reviewedCount = items.filter((i) => i.reviewed).length;
  const approvedCount = items.filter((i) => i.decision === "approved").length;
  const rejectedCount = items.filter((i) => i.decision === "rejected").length;
  const deferredCount = items.filter((i) => i.decision === "deferred").length;

  const activeItem = useMemo(
    () => filtered.find((item) => item.original_entry.id === activeId) ?? filtered[0] ?? null,
    [filtered, activeId],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (!activeItem || activeItem.reviewed || submitting || proposals.length > 0) return;
      if (event.key === "a") { event.preventDefault(); decide(activeItem.original_entry.id, "approve"); }
      else if (event.key === "r") { event.preventDefault(); decide(activeItem.original_entry.id, "reject"); }
      else if (event.key === "d") { event.preventDefault(); decide(activeItem.original_entry.id, "defer"); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeItem, submitting, note, proposals.length]);

  const related = useMemo(() => {
    if (!activeItem) return null;
    const entry = activeItem.original_entry;
    return {
      decisions: decisions.filter((d) => directDecisionLink(d, entry.id) || contextRelated(d, entry.context)).slice(0, 3),
      feedback: feedback.filter((f) => contextRelated(f, entry.context) || inferTextRelation(f.body, entry.body)).slice(0, 3),
    };
  }, [activeItem, decisions, feedback]);

  if (loading) return <div className="text-sm text-[var(--muted)]">Loading…</div>;
  if (loadError) return <div className="p-8 text-sm text-red-400">Could not load review data: {loadError}</div>;

  const hasConflicts = conflictList(selectedProposal?.possible_conflicts).length > 0;
  const revLabel = selectedProposal ? reversibilityLabel(selectedProposal.reversibility) : null;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Review"
        description="Ratify proposed continuity objects and assess incoming signals."
      />

      {/* ── Proposals: primary split-view ─────────────────────────────── */}
      {proposals.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-6 py-8 space-y-5">
          <div>
            <p className="text-sm font-medium mb-1">No proposals yet.</p>
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Candidate decisions appear here after they are surfaced from work or submitted directly. Review decides what becomes reusable future context.
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Surface from agent work</p>
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Harvest scans session files or pasted transcripts and routes qualifying candidates into this queue.
            </p>
            <pre className="rounded bg-[var(--panel-2)] border border-[var(--border)] p-3 text-xs leading-relaxed overflow-x-auto text-[var(--foreground)]">{`# Preview without submitting
python3 scripts/harvest_proposals.py --dry-run

# Submit to the review queue
python3 scripts/harvest_proposals.py --submit`}</pre>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Submit a candidate directly</p>
            <pre className="rounded bg-[var(--panel-2)] border border-[var(--border)] p-3 text-xs leading-relaxed overflow-x-auto text-[var(--foreground)]">{`curl -X POST http://localhost:3000/api/decisions \\
  -H "Content-Type: application/json" \\
  -d '{"body": "...", "status": "proposed", "summary_for_human": "..."}'`}</pre>
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
              Proposed decisions
              <span className="ml-2 rounded bg-[var(--border)] px-1.5 py-0.5 font-mono text-[10px]">{proposals.length}</span>
            </p>
            <p className="text-[10px] text-[var(--muted)]">
              <kbd className="rounded bg-[var(--border)] px-1 py-0.5 font-mono">j/k</kbd> navigate&ensp;
              <kbd className="rounded bg-[var(--border)] px-1 py-0.5 font-mono">↵</kbd> ratify&ensp;
              <kbd className="rounded bg-[var(--border)] px-1 py-0.5 font-mono">d</kbd> defer&ensp;
              <kbd className="rounded bg-[var(--border)] px-1 py-0.5 font-mono">x</kbd> reject
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_3fr]">
            {/* Left: queue */}
            <div className="space-y-2 xl:max-h-[75vh] xl:overflow-y-auto xl:pr-1">
              {proposals.map((p) => {
                const selected = p.id === selectedProposalId;
                const conflicts = conflictList(p.possible_conflicts);
                const rev = reversibilityLabel(p.reversibility);
                const cls = p.proposal_class ? CLASS_LABELS[p.proposal_class] ?? p.proposal_class : null;
                return (
                  <div
                    key={p.id}
                    onClick={() => { setSelectedProposalId(p.id); setDetailExpanded(false); }}
                    className={`cursor-pointer rounded-lg border p-3.5 transition-colors ${reversibilityBorder(p.reversibility)} ${
                      selected
                        ? "border-indigo-900 bg-[var(--surface)]"
                        : "border-[var(--border)] bg-[var(--panel-2)] hover:bg-[var(--surface)]"
                    }`}
                  >
                    {/* Meta row */}
                    <div className="mb-2 flex items-center gap-2 flex-wrap">
                      {cls && <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">{cls}</span>}
                      {rev && (
                        <span className="flex items-center gap-1">
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${rev.dot}`} />
                          <span className={`text-[10px] ${rev.color}`}>{rev.text}</span>
                        </span>
                      )}
                      {conflicts.length > 0 && (
                        <span className="rounded border border-[var(--brand-gold)] bg-[var(--brand-gold-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--brand-gold)]">
                          {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""}
                        </span>
                      )}
                      {p.confidence !== undefined && (
                        <span className="text-[10px] font-mono text-[var(--muted)]">{Math.round(p.confidence * 100)}%</span>
                      )}
                      <span className="ml-auto text-[10px] text-[var(--muted)]">{timeAgo(p.ts)}</span>
                    </div>

                    {/* Title */}
                    <p className="mb-1 text-sm font-semibold leading-snug">
                      {p.title ?? p.body.split("\n")[0].slice(0, 72)}
                    </p>

                    {/* Summary — this is the "what does it mean" answer */}
                    <p className="mb-3 line-clamp-2 text-xs leading-relaxed text-[var(--muted)]">
                      {p.summary_for_human ?? p.body}
                    </p>

                    <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {[
                        { status: "approved" as const, label: "Ratify", cls: "border-green-800 text-green-300 hover:bg-green-950" },
                        { status: "deferred" as const, label: "Defer", cls: "border-[var(--border)] text-[var(--muted)] hover:border-yellow-800 hover:text-yellow-300" },
                        { status: "rejected" as const, label: "Reject", cls: "border-[var(--border)] text-[var(--muted)] hover:border-red-800 hover:text-red-300" },
                      ].map((action) => (
                        <button
                          key={action.status}
                          onClick={() => actOnProposal(p.id, action.status)}
                          disabled={proposalActing === p.id}
                          className={`rounded border px-2 py-0.5 text-xs transition-colors disabled:opacity-40 ${action.cls}`}
                        >
                          {proposalActing === p.id ? "…" : action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Right: detail panel */}
            <div className="xl:sticky xl:top-6 xl:self-start">
              {!selectedProposal ? (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center text-sm text-[var(--muted)]">
                  Select a proposal.
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 space-y-5">

                  {/* ① Metadata strip — compact, at top */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--muted)]">
                    {selectedProposal.proposal_class && (
                      <span className="font-semibold uppercase tracking-wider">
                        {CLASS_LABELS[selectedProposal.proposal_class] ?? selectedProposal.proposal_class}
                      </span>
                    )}
                    {selectedProposal.scope && (
                      <span>{selectedProposal.scope}{selectedProposal.scope_ref && selectedProposal.scope_ref !== selectedProposal.scope ? ` · ${selectedProposal.scope_ref}` : ""}</span>
                    )}
                    {revLabel && (
                      <span className={`flex items-center gap-1 ${revLabel.color}`}>
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${revLabel.dot}`} />
                        {revLabel.text}
                      </span>
                    )}
                    {selectedProposal.confidence !== undefined && (
                      <span className="font-mono" title="Extraction confidence">
                        {Math.round(selectedProposal.confidence * 100)}% confidence
                      </span>
                    )}
                    <span className="ml-auto">{timeAgo(selectedProposal.ts)}</span>
                  </div>

                  {/* ② Title */}
                  <p className="text-base font-semibold leading-snug">
                    {selectedProposal.title ?? selectedProposal.body.split("\n")[0].slice(0, 90)}
                  </p>

                  {/* ③ What does it mean — the primary answer */}
                  {selectedProposal.summary_for_human && (
                    <div>
                      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">What it means</p>
                      <p className="text-sm font-medium leading-relaxed text-[var(--foreground)]">
                        {selectedProposal.summary_for_human}
                      </p>
                    </div>
                  )}

                  {/* ④ Why is it durable — visible by default, not hidden */}
                  {selectedProposal.rationale && (
                    <div className="border-l-2 border-[var(--border)] pl-3">
                      <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Why durable</p>
                      <p className="text-xs leading-relaxed text-[var(--muted)]">{selectedProposal.rationale}</p>
                    </div>
                  )}

                  {/* ⑤ Why surfaced — visible by default */}
                  {selectedProposal.why_surfaced && (
                    <div>
                      <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Why surfaced</p>
                      <p className="text-xs italic leading-relaxed text-[var(--muted)]">{selectedProposal.why_surfaced}</p>
                    </div>
                  )}

                  {/* ⑥ Conflict warning */}
                  {hasConflicts && (
                    <div className="rounded border border-[var(--brand-gold)] bg-[var(--brand-gold-soft)] px-3 py-2 text-xs text-[var(--brand-gold)]">
                      <p className="mb-1 font-medium">Possible conflicts</p>
                      <ul className="space-y-0.5">
                        {conflictList(selectedProposal.possible_conflicts).map((c, i) => (
                          <li key={i}>· {c}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* ⑦ Full statement — expandable */}
                  <div>
                    <button
                      onClick={() => setDetailExpanded((v) => !v)}
                      className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
                    >
                      Full statement
                      <span className="text-[9px]">{detailExpanded ? "▲" : "▼"}</span>
                    </button>
                    {detailExpanded ? (
                      <p className="text-xs leading-relaxed text-[var(--foreground)]">{selectedProposal.body}</p>
                    ) : (
                      <p className="line-clamp-2 text-xs leading-relaxed text-[var(--muted)]">{selectedProposal.body}</p>
                    )}
                  </div>

                  {/* ⑧ Related approved decisions */}
                  {relatedDecisions.length > 0 && (
                    <div>
                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Related decisions</p>
                      <div className="space-y-1.5">
                        {relatedDecisions.map((d) => (
                          <div key={d.id} className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
                            <div className="mb-1 flex items-center gap-2">
                              <StatusBadge text={d.decision} tone={toneForDecision(d.decision)} />
                              <span className="text-[10px] text-[var(--muted)]">{timeAgo(d.ts)}</span>
                            </div>
                            <p className="text-xs leading-relaxed text-[var(--muted)] line-clamp-2">{d.title ?? d.proposal}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ⑨ Actions */}
                  <div className="border-t border-[var(--border)] pt-4 space-y-2">
                    <div className="flex gap-2">
                      {[
                        { status: "approved" as const, label: "Ratify", cls: "border-green-800 text-green-300 hover:bg-green-950 flex-1" },
                        { status: "deferred" as const, label: "Defer", cls: "border-[var(--border)] text-[var(--muted)] hover:border-yellow-800 hover:text-yellow-300" },
                        { status: "rejected" as const, label: "Reject", cls: "border-[var(--border)] text-[var(--muted)] hover:border-red-800 hover:text-red-300" },
                      ].map((action) => (
                        <button
                          key={action.status}
                          onClick={() => actOnProposal(selectedProposal.id, action.status)}
                          disabled={proposalActing === selectedProposal.id}
                          className={`rounded border px-3 py-2 text-sm transition-colors disabled:opacity-40 ${action.cls}`}
                        >
                          {proposalActing === selectedProposal.id ? "…" : action.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-[var(--muted)] leading-relaxed">
                      <span className="text-green-400/80">Ratify</span> — decision becomes eligible for injection into future sessions.{" "}
                      <span className="text-yellow-400/70">Defer</span> — hold for later; not injected.{" "}
                      <span className="text-red-400/70">Reject</span> — excluded permanently; kept in history.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Review queue: secondary ────────────────────────────────────── */}
      {items.length > 0 && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <SectionCard title="Review queue" tone="action">
            <div className="mb-5 flex gap-1 border-b border-[var(--border)]">
              {([
                { key: "pending" as const, label: "Pending review", count: pendingCount },
                { key: "reviewed" as const, label: "Handled", count: reviewedCount },
                { key: "all" as const, label: "All", count: items.length },
              ]).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => { setFilter(tab.key); setActiveId(null); }}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                    filter === tab.key
                      ? "border-[var(--accent)] text-[var(--foreground)]"
                      : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {tab.label}
                  <span className="ml-1.5 rounded bg-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--muted)]">{tab.count}</span>
                </button>
              ))}
            </div>

            <div className="mb-4">
              <StackedBar segments={[
                { label: "pending", value: pendingCount, tone: "warning" },
                { label: "approved", value: approvedCount, tone: "success" },
                { label: "rejected", value: rejectedCount, tone: "danger" },
                { label: "deferred", value: deferredCount, tone: "reflection" },
              ]} />
            </div>

            {filtered.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">{filter === "pending" ? "Nothing to review." : "No items."}</p>
            ) : (
              <div className="space-y-2">
                {filtered.map((item) => {
                  const id = item.original_entry.id;
                  const selected = activeItem?.original_entry.id === id;
                  return (
                    <div
                      key={id}
                      onClick={() => setActiveId(id)}
                      className={`cursor-pointer rounded-lg border p-3.5 transition-colors ${
                        selected ? "border-indigo-900 bg-[var(--panel-2)]" : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--panel-2)]"
                      }`}
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        <StatusBadge text={item.original_entry.source} tone="accent" />
                        <StatusBadge text={item.original_entry.type} tone={item.original_entry.type === "proposal" ? "warning" : item.original_entry.type === "interpretation" ? "reflection" : "neutral"} />
                        <StatusBadge text={item.original_entry.context} tone="neutral" />
                        <span className="ml-auto text-[10px] text-[var(--muted)]">{timeAgo(item.ts)}</span>
                        {item.reviewed && item.decision && <StatusBadge text={item.decision} tone={toneForDecision(item.decision)} />}
                      </div>
                      <p className="mb-2.5 text-sm leading-relaxed">{item.original_entry.body}</p>
                      {item.reviewed && item.note && <p className="mb-2 text-xs italic text-[var(--muted)]">"{item.note}"</p>}
                      {!item.reviewed && (
                        <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                          {[
                            { key: "approve", label: "Approve", cls: "border-green-800 text-green-300 hover:bg-green-950" },
                            { key: "reject", label: "Reject", cls: "border-red-800 text-red-300 hover:bg-red-950" },
                            { key: "defer", label: "Defer", cls: "border-yellow-800 text-yellow-300 hover:bg-yellow-950" },
                          ].map((action) => (
                            <button
                              key={action.key}
                              onClick={() => decide(id, action.key)}
                              disabled={submitting}
                              className={`rounded border px-2 py-0.5 text-xs transition-colors disabled:opacity-40 ${action.cls}`}
                            >
                              {action.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>

          <div className="space-y-4 xl:sticky xl:top-6 xl:self-start">
            <SectionCard title="Context" tone="artifact">
              {!activeItem || !related ? (
                <p className="text-sm text-[var(--muted)]">Select an item.</p>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm leading-relaxed">{activeItem.original_entry.body}</p>

                  {!activeItem.reviewed && (
                    <div className="space-y-2">
                      <input
                        type="text"
                        placeholder="Optional note…"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder-[var(--muted)] focus:border-[var(--accent)] focus:outline-none"
                      />
                      <div className="flex gap-2">
                        {[
                          { key: "approve", label: "Approve", cls: "border-green-800 text-green-300 hover:bg-green-950 flex-1" },
                          { key: "reject", label: "Reject", cls: "border-red-800 text-red-300 hover:bg-red-950" },
                          { key: "defer", label: "Defer", cls: "border-yellow-800 text-yellow-300 hover:bg-yellow-950" },
                        ].map((action) => (
                          <button
                            key={action.key}
                            onClick={() => decide(activeItem.original_entry.id, action.key)}
                            disabled={submitting}
                            className={`rounded border px-3 py-2 text-sm transition-colors disabled:opacity-40 ${action.cls}`}
                          >
                            {submitting ? "…" : action.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {related.decisions.length > 0 && (
                    <div>
                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Decisions</p>
                      <div className="space-y-1.5">
                        {related.decisions.map((d) => (
                          <div key={d.id} className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-2.5">
                            <div className="mb-1 flex items-center gap-1.5">
                              <StatusBadge text={d.decision} tone={toneForDecision(d.decision)} />
                              <span className="text-[10px] text-[var(--muted)]">{timeAgo(d.ts)}</span>
                            </div>
                            <p className="text-xs leading-relaxed text-[var(--muted)] line-clamp-2">{d.proposal}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                </div>
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  );
}
