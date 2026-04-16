"use client";

import { useEffect, useMemo, useState } from "react";
import { PageHeader, ProjectBar, StatusBadge } from "../components/ui";
import { timeAgo } from "../../lib/utils";

type Decision = {
  id: string;
  title?: string;
  body: string;
  rationale?: string;
  summary_for_human?: string;
  why_surfaced?: string;
  proposal_class?: string;
  scope?: string;
  scope_ref?: string;
  reversibility?: "low" | "medium" | "high";
  possible_conflicts?: Array<{ id: string; title: string } | string>;
  confidence?: number;
  transfer_tier?: string;
  ratified_by?: string;
  created_at?: string;
  ts?: string;
  tags?: string[];
  project_id?: string;
  status?: string;
  note?: string;
  review_after?: string;
};

type DecisionOutcome = {
  summary: {
    injected_count: number;
    excluded_count: number;
    annotation_count: number;
    annotation_counts: Record<string, number>;
    exclusion_reasons: Record<string, number>;
  };
  recent_runs: Array<{
    run_id: string;
    ts: string;
    project?: string | null;
    agent?: string | null;
    source?: string | null;
    result: "injected" | "excluded";
    reason?: string;
  }>;
  annotations: Array<{
    annotation_id: string;
    run_id: string;
    ts: string;
    annotation_type: string;
    value: boolean;
    note?: string | null;
  }>;
};

const CLASS_LABELS: Record<string, string> = {
  // Canonical classes
  architectural_decision: "Architecture",
  durable_workflow_rule:  "Workflow",
  scoped_exception:       "Exception",
  durable_constraint:     "Constraint",
  // Legacy aliases
  workflow_rule:              "Workflow",
  scoped_implementation_rule: "Implementation",
  release_or_ops_config:      "Ops/Config",
};

const REVERSIBILITY_DOT: Record<string, { label: string; color: string }> = {
  low:    { label: "hard to reverse",       color: "var(--tone-danger, #ef4444)" },
  medium: { label: "moderately reversible", color: "var(--tone-warning, #f59e0b)" },
  high:   { label: "easy to revise",        color: "var(--tone-success, #22c55e)" },
};

// What each tier means in plain language
const TIER_LABEL: Record<string, { text: string; muted: boolean }> = {
  always:       { text: "Always active",          muted: false },
  by_project:   { text: "Active per project",     muted: false },
  explicit:     { text: "Not auto-active",         muted: true },
  history_only: { text: "History only",           muted: true },
  re_ratify:    { text: "Re-ratification required", muted: true },
};

const OUTCOME_LABELS: Record<string, string> = {
  context_restatement_required: "Context restated",
  continuity_correction_required: "Correction required",
  stale_leakage_detected: "Stale leakage",
  approved_decision_followed: "Followed",
  approved_decision_not_followed: "Not followed",
};

function TierBadge({ tier, scopeRef }: { tier?: string; scopeRef?: string }) {
  if (!tier) return null;
  const info = TIER_LABEL[tier];
  if (!info) return null;
  const label = tier === "by_project" && scopeRef ? `Active for ${scopeRef}` : info.text;
  return (
    <span className={`text-xs ${info.muted ? "text-[var(--muted)]" : "text-indigo-400"}`}>
      {label}
    </span>
  );
}

function DecisionCard({ d, onRevoked, onUpdated }: {
  d: Decision;
  onRevoked: (id: string) => void;
  onUpdated: (id: string, fields: Partial<Decision>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [superseding, setSuperseding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [supersedeBody, setSupersedeBody] = useState(d.body);
  const [supersedeRationale, setSupersedeRationale] = useState(d.rationale ?? "");
  const [supersedeRatifiedBy, setSupersedeRatifiedBy] = useState("");
  const [editNote, setEditNote] = useState(d.note ?? "");
  const [editReviewAfter, setEditReviewAfter] = useState(d.review_after?.slice(0, 10) ?? "");
  const [editConfidence, setEditConfidence] = useState(
    typeof d.confidence === "number" ? String(Math.round(d.confidence * 100)) : "80"
  );
  const [outcome, setOutcome] = useState<DecisionOutcome | null>(null);
  const [outcomeLoading, setOutcomeLoading] = useState(false);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);

  const title = d.title || d.body.split("\n")[0].slice(0, 120);
  const classLabel = d.proposal_class ? (CLASS_LABELS[d.proposal_class] ?? d.proposal_class) : null;
  const rev = d.reversibility ? REVERSIBILITY_DOT[d.reversibility] : null;
  const ts = d.created_at ?? d.ts;
  const isDeferred = d.status === "deferred";

  useEffect(() => {
    if (!expanded || outcome) return;
    let cancelled = false;
    setOutcomeLoading(true);
    setOutcomeError(null);
    fetch(`/api/decisions/${encodeURIComponent(d.id)}/outcomes`)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load continuity outcomes");
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setOutcome(data);
      })
      .catch((err) => {
        if (!cancelled) setOutcomeError(err instanceof Error ? err.message : "Failed to load continuity outcomes");
      })
      .finally(() => {
        if (!cancelled) setOutcomeLoading(false);
      });
    return () => { cancelled = true; };
  }, [expanded, outcome, d.id]);

  async function handleRevoke() {
    setSaving(true);
    await fetch("/api/decisions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: d.id, status: "deferred" }),
    });
    setSaving(false);
    setRevoking(false);
    onRevoked(d.id);
  }

  async function handleSupersede() {
    if (!supersedeBody.trim() || !supersedeRatifiedBy.trim()) return;
    setSaving(true);
    const res = await fetch("/api/decisions/supersede", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: supersedeBody.trim(),
        rationale: supersedeRationale.trim() || undefined,
        ratified_by: supersedeRatifiedBy.trim(),
        supersedes: [d.id],
        scope: d.scope,
        transfer_tier: d.transfer_tier,
        confidence: d.confidence,
        project: d.project_id ?? undefined,
      }),
    });
    setSaving(false);
    if (res.ok) {
      setSuperseding(false);
      onRevoked(d.id); // old decision is now superseded — remove from active list
    }
  }

  async function handleSave() {
    setSaving(true);
    const fields: Record<string, unknown> = {};
    if (editNote !== (d.note ?? "")) fields.note = editNote;
    if (editReviewAfter !== (d.review_after?.slice(0, 10) ?? "")) {
      fields.review_after = editReviewAfter ? new Date(editReviewAfter).toISOString() : null;
    }
    const confNum = Number(editConfidence) / 100;
    if (!isNaN(confNum) && Math.abs(confNum - (d.confidence ?? 0.8)) > 0.001) {
      fields.confidence = confNum;
    }
    if (Object.keys(fields).length > 0) {
      await fetch("/api/decisions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id, ...fields }),
      });
      onUpdated(d.id, fields as Partial<Decision>);
    }
    setSaving(false);
    setEditing(false);
  }

  return (
    <div className={`rounded-lg border bg-[var(--surface)] ${isDeferred ? "border-[var(--border)] opacity-60" : "border-[var(--border)]"}`}>
      <button
        onClick={() => { setExpanded((v) => !v); setEditing(false); setRevoking(false); setSuperseding(false); }}
        className="w-full text-left px-4 py-3"
      >
        {/* Meta strip */}
        <div className="mb-1.5 flex items-center gap-2 flex-wrap">
          {classLabel && <StatusBadge text={classLabel} tone="neutral" />}
          {d.scope && d.scope !== "global" && <StatusBadge text={d.scope} tone="neutral" />}
          {rev && (
            <span className="flex items-center gap-1 text-xs text-[var(--muted)]">
              <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: rev.color }} />
              {rev.label}
            </span>
          )}
          <TierBadge tier={d.transfer_tier} scopeRef={d.scope_ref ?? d.project_id ?? undefined} />
          {isDeferred && <span className="text-xs text-[var(--muted)]">deferred</span>}
          {ts && <span className="text-xs text-[var(--muted)] ml-auto">{timeAgo(ts)}</span>}
        </div>

        {/* Title */}
        <p className="text-sm font-semibold text-[var(--foreground)]">{title}</p>

        {/* Summary */}
        {d.summary_for_human && (
          <p className="mt-1 text-xs text-[var(--muted)] line-clamp-2">{d.summary_for_human}</p>
        )}
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] px-4 py-3 space-y-4">
          {d.rationale && (
            <div className="border-l-2 border-[var(--border)] pl-3">
              <p className="text-xs uppercase tracking-wider text-[var(--muted)] mb-1">Why durable</p>
              <p className="text-sm">{d.rationale}</p>
            </div>
          )}

          <div>
            <p className="text-xs uppercase tracking-wider text-[var(--muted)] mb-1">Evidence</p>
            <p className="text-sm whitespace-pre-line">{d.body}</p>
            {d.why_surfaced && (
              <p className="mt-1 text-xs text-[var(--muted)]">Trigger: {d.why_surfaced}</p>
            )}
          </div>

          <div className="flex flex-wrap gap-4 text-xs text-[var(--muted)]">
            {d.ratified_by && <span>Ratified by: <span className="text-[var(--foreground)]">{d.ratified_by}</span></span>}
            {typeof d.confidence === "number" && <span>Confidence: <span className="text-[var(--foreground)]">{Math.round(d.confidence * 100)}%</span></span>}
            {d.review_after && <span>Review after: <span className="text-[var(--foreground)]">{d.review_after.slice(0, 10)}</span></span>}
            {d.transfer_tier && <span>Injection: <span className="text-[var(--foreground)]">{TIER_LABEL[d.transfer_tier]?.text ?? d.transfer_tier}</span></span>}
          </div>

          <div className="rounded border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-wider text-[var(--muted)]">Continuity outcomes</p>
              {outcomeLoading && <span className="text-xs text-[var(--muted)]">Loading…</span>}
            </div>
            {outcomeError ? (
              <p className="text-xs text-red-400">{outcomeError}</p>
            ) : outcome ? (
              <div className="space-y-2">
                {outcome.recent_runs.length > 0 ? (
                  <>
                    <div className="flex flex-wrap gap-3 text-xs">
                      <span><span className="text-indigo-400">{outcome.summary.injected_count}</span> injected</span>
                      <span><span className="text-[var(--foreground)]">{outcome.summary.excluded_count}</span> excluded</span>
                      <span><span className="text-[var(--foreground)]">{outcome.summary.annotation_count}</span> outcome signals</span>
                    </div>
                    {(Object.keys(outcome.summary.annotation_counts).length > 0 || Object.keys(outcome.summary.exclusion_reasons).length > 0) && (
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(outcome.summary.annotation_counts).map(([type, count]) => (
                          <span key={type} className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">
                            {OUTCOME_LABELS[type] ?? type}: {count}
                          </span>
                        ))}
                        {Object.entries(outcome.summary.exclusion_reasons).map(([reason, count]) => (
                          <span key={reason} className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">
                            excluded: {reason} ({count})
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="space-y-1">
                      {outcome.recent_runs.slice(0, 3).map((run) => (
                        <div key={`${run.run_id}-${run.result}`} className="flex items-center gap-2 text-xs text-[var(--muted)]">
                          <span className={run.result === "injected" ? "text-indigo-400" : "text-amber-400"}>{run.result}</span>
                          <span className="font-mono">{run.run_id.slice(0, 16)}…</span>
                          {run.reason && <span>{run.reason}</span>}
                          <span className="ml-auto">{timeAgo(run.ts)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-[var(--muted)]">No continuity runs have referenced this decision yet.</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-[var(--muted)]">Outcome data will appear after this decision is injected or excluded in a continuity run.</p>
            )}
          </div>

          {d.note && !editing && (
            <div className="rounded bg-[var(--panel-2)] px-3 py-2">
              <p className="text-xs text-[var(--muted)] mb-0.5">Note</p>
              <p className="text-sm">{d.note}</p>
            </div>
          )}

          {d.tags && d.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {d.tags.map((tag) => (
                <span key={tag} className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">{tag}</span>
              ))}
            </div>
          )}

          {/* Edit form */}
          {editing && (
            <div className="space-y-3 rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
              <div>
                <label className="text-xs text-[var(--muted)] block mb-1">Note</label>
                <textarea
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  rows={3}
                  className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-indigo-700"
                  placeholder="Add a note…"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-[var(--muted)] block mb-1">Review after</label>
                  <input
                    type="date"
                    value={editReviewAfter}
                    onChange={(e) => setEditReviewAfter(e.target.value)}
                    className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-indigo-700"
                  />
                </div>
                <div>
                  <label className="text-xs text-[var(--muted)] block mb-1">Confidence: {editConfidence}%</label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={editConfidence}
                    onChange={(e) => setEditConfidence(e.target.value)}
                    className="w-full"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded bg-indigo-700 px-3 py-1.5 text-xs text-white hover:bg-indigo-600 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Revoke confirm */}
          {revoking && (
            <div className="rounded border border-amber-800/40 bg-amber-950/20 p-3">
              <p className="text-sm text-[var(--foreground)] mb-2">
                Revoke this decision? It will be removed from the active agent context but kept in history.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleRevoke}
                  disabled={saving}
                  className="rounded bg-amber-700 px-3 py-1.5 text-xs text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Yes, revoke"}
                </button>
                <button
                  onClick={() => setRevoking(false)}
                  className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Supersede form */}
          {superseding && (
            <div className="space-y-3 rounded border border-indigo-800/40 bg-indigo-950/20 p-3">
              <p className="text-xs font-medium text-indigo-300">Replace with new decision</p>
              <p className="text-xs text-[var(--muted)]">
                The current decision will be marked as "superseded". The new version below takes its place.
              </p>
              <div>
                <label className="text-xs text-[var(--muted)] block mb-1">New content <span className="text-red-400">*</span></label>
                <textarea
                  value={supersedeBody}
                  onChange={(e) => setSupersedeBody(e.target.value)}
                  rows={4}
                  className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-indigo-700"
                  placeholder="Describe the new decision…"
                />
              </div>
              <div>
                <label className="text-xs text-[var(--muted)] block mb-1">Reason for change</label>
                <textarea
                  value={supersedeRationale}
                  onChange={(e) => setSupersedeRationale(e.target.value)}
                  rows={2}
                  className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-indigo-700"
                  placeholder="Why is the previous decision being replaced?"
                />
              </div>
              <div>
                <label className="text-xs text-[var(--muted)] block mb-1">Ratified by <span className="text-red-400">*</span></label>
                <input
                  type="text"
                  value={supersedeRatifiedBy}
                  onChange={(e) => setSupersedeRatifiedBy(e.target.value)}
                  className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-indigo-700"
                  placeholder="name or role…"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSupersede}
                  disabled={saving || !supersedeBody.trim() || !supersedeRatifiedBy.trim()}
                  className="rounded bg-indigo-700 px-3 py-1.5 text-xs text-white hover:bg-indigo-600 disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Confirm"}
                </button>
                <button
                  onClick={() => setSuperseding(false)}
                  className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Action row */}
          {!editing && !revoking && !superseding && !isDeferred && (
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setEditing(true)}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => { setSuperseding(true); setSupersedeBody(d.body); setSupersedeRationale(d.rationale ?? ""); setSupersedeRatifiedBy(""); }}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-indigo-400 transition-colors"
              >
                Supersede
              </button>
              <button
                onClick={() => setRevoking(true)}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-amber-400 transition-colors"
              >
                Revoke
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


const STORAGE_KEY = "govinuity:continuity-file-path";

function GeneratePanel({ activeProject }: { activeProject: string | null }) {
  const [open, setOpen] = useState(false);
  const [outputPath, setOutputPath] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(STORAGE_KEY) ?? "";
  });
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ path: string; decision_count: number; bytes: number; run_id: string; action: "created" | "updated" } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handlePathChange(value: string) {
    setOutputPath(value);
    setResult(null);
    setError(null);
    if (typeof window !== "undefined") {
      if (value.trim()) localStorage.setItem(STORAGE_KEY, value);
      else localStorage.removeItem(STORAGE_KEY);
    }
  }

  async function generate() {
    if (!outputPath.trim()) return;
    setGenerating(true);
    setResult(null);
    setError(null);
    const res = await fetch("/api/continuity-file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        output_path: outputPath.trim(),
        project: activeProject ?? undefined,
      }),
    });
    const data = await res.json();
    setGenerating(false);
    if (res.ok) {
      setResult(data);
    } else {
      setError(data.error ?? "Unknown error");
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-center gap-2"
      >
        <span className="text-sm font-medium">Generate for Claude Code</span>
        <span className="text-xs text-[var(--muted)]">— write GOVERNED_CONTINUITY.md to a local path</span>
        <span className="ml-auto text-xs text-[var(--muted)]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)] px-4 py-3 space-y-3">
          <p className="text-xs text-[var(--muted)]">
            Writes the active decisions as an instruction file to the specified path. Reference it once from your <code className="font-mono bg-[var(--panel-2)] px-1 rounded">CLAUDE.md</code>. Re-run whenever decisions change to keep the file current.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={outputPath}
              onChange={(e) => handlePathChange(e.target.value)}
              placeholder="/Users/you/project/.claude/GOVERNED_CONTINUITY.md"
              className="flex-1 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-indigo-700 font-mono"
            />
            <button
              onClick={generate}
              disabled={generating || !outputPath.trim()}
              className="rounded bg-indigo-700 px-3 py-1.5 text-xs text-white hover:bg-indigo-600 disabled:opacity-40 whitespace-nowrap"
            >
              {generating ? "Writing…" : result?.action === "updated" ? "Update" : "Generate"}
            </button>
          </div>
          {result && (
            <p className="text-xs text-green-400 font-mono">
              {result.action === "updated" ? "Updated" : "Created"} · {result.decision_count} decision{result.decision_count !== 1 ? "s" : ""} · {result.bytes} bytes · run {result.run_id.slice(0, 16)}…
            </p>
          )}
          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function DecisionsPage() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [expiring, setExpiring] = useState<Decision[]>([]);
  const [stale, setStale] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showDeferred, setShowDeferred] = useState(false);

  function reload() {
    setLoading(true);
    setLoadError(null);
    const proj = activeProject ? `&project=${activeProject}` : "";

    const fetches: Promise<Decision[]>[] = [
      fetch(`/api/decisions?status=approved&limit=500${proj}`).then((r) => r.json()).then((d) => d.entries ?? []),
      fetch(`/api/decisions?expiring=true&within=14${proj}`).then((r) => r.json()).then((d) => d.entries ?? []),
    ];
    if (showDeferred) {
      fetches.push(fetch(`/api/decisions?status=deferred&limit=500${proj}`).then((r) => r.json()).then((d) => d.entries ?? []));
    }

    Promise.all(fetches).then(([approved, expiringList, deferred]) => {
      const staleList = approved.filter((e) => {
        if (!e.review_after) return false;
        return new Date(e.review_after) <= new Date();
      });
      setDecisions([...approved, ...(deferred ?? [])]);
      setExpiring(expiringList);
      setStale(staleList);
      setLoading(false);
    }).catch((err) => {
      setLoadError(err instanceof Error ? err.message : "Failed to load decisions");
      setLoading(false);
    });
  }

  useEffect(() => { reload(); }, [activeProject, showDeferred]);

  const approvedCount = useMemo(() => decisions.filter((d) => d.status === "approved").length, [decisions]);

  const classes = useMemo(() => {
    const seen = new Set<string>();
    decisions.forEach((d) => { if (d.proposal_class) seen.add(d.proposal_class); });
    return [...seen];
  }, [decisions]);

  const staleIds = useMemo(() => new Set(stale.map((d) => d.id)), [stale]);

  const filtered = useMemo(() => {
    let list = decisions;
    // Stale decisions appear in the alert block above — exclude from main list
    list = list.filter((d) => !staleIds.has(d.id));
    if (classFilter) list = list.filter((d) => d.proposal_class === classFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((d) =>
        (d.title ?? d.body).toLowerCase().includes(q) ||
        d.summary_for_human?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [decisions, classFilter, search, staleIds]);

  function handleRevoked(id: string) {
    setDecisions((prev) => prev.map((d) => d.id === id ? { ...d, status: "deferred" } : d));
  }

  function handleUpdated(id: string, fields: Partial<Decision>) {
    setDecisions((prev) => prev.map((d) => d.id === id ? { ...d, ...fields } : d));
  }

  if (loading) return <div className="text-[var(--muted)] text-sm">Loading…</div>;
  if (loadError) return <div className="p-8 text-sm text-red-400">Could not load decisions: {loadError}</div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Decisions"
        description={`${approvedCount} active memories${stale.length > 0 ? ` · ${stale.length} expired` : ""}${expiring.length > 0 ? ` · ${expiring.length} expiring soon` : ""} — injected based on scope and tier.`}
      />

      <ProjectBar activeProject={activeProject} onSelect={setActiveProject} />

      <GeneratePanel activeProject={activeProject} />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-indigo-700"
        />
        <button
          onClick={() => setClassFilter(null)}
          className={`rounded border px-3 py-1.5 text-xs transition-colors ${!classFilter ? "border-indigo-700 bg-indigo-950/60 text-indigo-300" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}
        >
          All classes
        </button>
        {classes.map((cls) => (
          <button
            key={cls}
            onClick={() => setClassFilter(classFilter === cls ? null : cls)}
            className={`rounded border px-3 py-1.5 text-xs transition-colors ${classFilter === cls ? "border-indigo-700 bg-indigo-950/60 text-indigo-300" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}
          >
            {CLASS_LABELS[cls] ?? cls}
          </button>
        ))}
        <button
          onClick={() => setShowDeferred((v) => !v)}
          className={`ml-auto rounded border px-3 py-1.5 text-xs transition-colors ${showDeferred ? "border-indigo-700 bg-indigo-950/60 text-indigo-300" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}
        >
          {showDeferred ? "Hide deferred" : "Show deferred"}
        </button>
      </div>

      {/* Stale — expired review_after, silently dropped from injection */}
      {stale.length > 0 && (
        <div className="rounded-lg border border-red-900/40 bg-red-950/10 px-4 py-3">
          <p className="text-xs font-medium text-red-400 mb-2">
            {stale.length} decision{stale.length > 1 ? "s" : ""} expired — no longer active in agent context
          </p>
          <div className="space-y-1">
            {stale.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-[var(--foreground)]">{d.title || d.body.slice(0, 80)}</span>
                <span className="text-[var(--muted)] shrink-0">review after {d.review_after?.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expiring soon — still active, needs renewal attention */}
      {expiring.length > 0 && (
        <div className="rounded-lg border border-amber-900/40 bg-amber-950/10 px-4 py-3">
          <p className="text-xs font-medium text-amber-400 mb-2">
            {expiring.length} decision{expiring.length > 1 ? "s expiring" : " expiring"} soon
          </p>
          <div className="space-y-1">
            {expiring.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-[var(--foreground)]">{d.title || d.body.slice(0, 80)}</span>
                <span className="text-[var(--muted)] shrink-0">review after {d.review_after?.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          {decisions.length === 0 ? (
            <>No ratified decisions yet. Ratify proposals on the <a href="/review" className="text-[var(--accent)] hover:underline">Review</a> page to populate this list.</>
          ) : "No results for this filter."}
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((d) => (
            <DecisionCard key={d.id} d={d} onRevoked={handleRevoked} onUpdated={handleUpdated} />
          ))}
        </div>
      )}
    </div>
  );
}
