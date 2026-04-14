"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard, StackedBar, StatusBadge } from "../../../components/ui";
import { relationLabel, relationTone } from "../../../../lib/relations";
import { decisionLabel, toneForDecision, timeAgo } from "../../../../lib/utils";
import type { DecisionV2 } from "../../../../lib/utils";

// Extend DecisionV2 with legacy aliases returned by the API during Phase 1
type DecisionEntry = DecisionV2 & {
  decision: string;    // alias for status
  proposal: string;   // alias for body
  ts: string;         // alias for created_at
};

type Filter = "all" | "approved" | "rejected" | "deferred" | "superseded" | "open-followup";

// Renewal presets in weeks
const RENEWAL_OPTIONS = [
  { label: "2w", weeks: 2 },
  { label: "1m", weeks: 4 },
  { label: "3m", weeks: 13 },
  { label: "6m", weeks: 26 },
];

function addWeeks(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString();
}

export default function WorkspaceDecisionsPage({ params }: { params: Promise<{ slug: string }> }) {
  const [slug, setSlug] = useState("");
  const [entries, setEntries] = useState<DecisionEntry[]>([]);
  const [stale, setStale] = useState<DecisionEntry[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);
  const [expandedSuperseded, setExpandedSuperseded] = useState<Set<string>>(new Set());
  const [renewingId, setRenewingId] = useState<string | null>(null);

  async function load(projectSlug: string) {
    setLoadError(null);
    try {
      const [decisionsData, staleData] = await Promise.all([
        fetch(`/api/decisions?project=${projectSlug}&limit=100`).then((r) => r.json()),
        fetch(`/api/decisions/stale?project=${projectSlug}`).then((r) => r.json()),
      ]);
      setEntries(decisionsData.entries ?? []);
      setStale(staleData.decisions ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load decisions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    params.then(({ slug }) => {
      setSlug(slug);
      load(slug);
    });
  }, [params]);

  async function setFollowUpState(entry: DecisionEntry, followUpState: "open" | "resolved") {
    const key = entry.id;
    setUpdatingKey(key);
    const res = await fetch("/api/decisions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: entry.id, ts: entry.created_at ?? entry.ts, follow_up_state: followUpState }),
    }).then((r) => r.json());
    setUpdatingKey(null);
    if (!res.error) await load(slug);
  }

  async function renew(entry: DecisionEntry, weeks: number) {
    setRenewingId(entry.id);
    await fetch("/api/decisions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: entry.id, review_after: addWeeks(weeks) }),
    });
    setRenewingId(null);
    await load(slug);
  }

  function toggleSuperseded(id: string) {
    setExpandedSuperseded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Index for supersession chain lookups
  const entryById = useMemo(() => {
    const map = new Map<string, DecisionEntry>();
    for (const e of entries) map.set(e.id, e);
    return map;
  }, [entries]);

  const filtered = useMemo(() => {
    const statusVal = (e: DecisionEntry) => e.status ?? e.decision;
    if (filter === "approved") return entries.filter((e) => statusVal(e) === "approved");
    if (filter === "rejected") return entries.filter((e) => statusVal(e) === "rejected");
    if (filter === "deferred") return entries.filter((e) => statusVal(e) === "deferred");
    if (filter === "superseded") return entries.filter((e) => statusVal(e) === "superseded");
    if (filter === "open-followup") return entries.filter((e) => (e.follow_up_state ?? "open") === "open" && statusVal(e) !== "superseded");
    return entries;
  }, [entries, filter]);

  const statusVal = (e: DecisionEntry) => e.status ?? e.decision;
  const approvedCount = entries.filter((e) => statusVal(e) === "approved").length;
  const rejectedCount = entries.filter((e) => statusVal(e) === "rejected").length;
  const deferredCount = entries.filter((e) => statusVal(e) === "deferred").length;
  const supersededCount = entries.filter((e) => statusVal(e) === "superseded").length;

  if (loadError) return <div className="p-8 text-sm text-red-400">Could not load decisions: {loadError}</div>;

  return (
    <div>
      <PageHeader
        title={`Decision Log · ${slug}`}
        description="Project-scoped decision timeline, including provenance and follow-up status."
        actions={<Link href={`/workspaces/${slug}`} className="text-sm text-[var(--accent)] hover:underline">← dashboard</Link>}
      />

      {/* Needs Review — stale decisions requiring renewal or supersession */}
      {stale.length > 0 && (
        <div className="mb-6 rounded-lg border border-yellow-800 bg-yellow-950/30 p-4">
          <p className="mb-3 text-sm font-medium text-yellow-300">
            {stale.length} decision{stale.length === 1 ? "" : "s"} need{stale.length === 1 ? "s" : ""} review
            <span className="ml-2 text-xs font-normal text-yellow-600">review_after has elapsed — renew or supersede</span>
          </p>
          <div className="space-y-3">
            {stale.map((entry) => (
              <div key={entry.id} className="rounded border border-yellow-900 bg-[var(--surface)] p-3">
                <div className="mb-1 flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium leading-snug">{entry.title ?? entry.body ?? entry.proposal}</p>
                    {entry.rationale && (
                      <p className="mt-0.5 text-xs text-[var(--muted)]">{entry.rationale}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-yellow-600">
                    expired {timeAgo(entry.review_after ?? undefined)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-[var(--muted)]">Renew for:</span>
                  {RENEWAL_OPTIONS.map(({ label, weeks }) => (
                    <button
                      key={label}
                      onClick={() => renew(entry, weeks)}
                      disabled={renewingId === entry.id}
                      className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)] hover:border-yellow-700 hover:text-yellow-300 disabled:opacity-40 transition-colors"
                    >
                      {renewingId === entry.id ? "…" : label}
                    </button>
                  ))}
                  <span className="text-[var(--border)]">·</span>
                  <span className="text-xs text-[var(--muted)]">or supersede via the decision log below</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <SectionCard title="Decision log" tone="artifact">
          <div className="mb-4 flex gap-2 flex-wrap">
            {([
              ["all", "All"],
              ["approved", "Approved"],
              ["rejected", "Rejected"],
              ["deferred", "Deferred"],
              ["superseded", "Superseded"],
              ["open-followup", "Open follow-up"],
            ] as [Filter, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`rounded border px-2 py-1 text-xs transition-colors ${
                  filter === key ? "border-[var(--accent)] text-[var(--foreground)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mb-5">
            <StackedBar
              segments={[
                { label: "approved", value: approvedCount, tone: "success" },
                { label: "rejected", value: rejectedCount, tone: "danger" },
                { label: "deferred", value: deferredCount, tone: "warning" },
                { label: "superseded", value: supersededCount, tone: "neutral" },
              ]}
            />
          </div>

          {loading ? (
            <p className="text-sm text-[var(--muted)]">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No decisions for this filter.</p>
          ) : (
            <div className="space-y-3">
              {filtered.map((entry) => {
                const st = statusVal(entry);
                const isSuperseded = st === "superseded";
                const isExpanded = expandedSuperseded.has(entry.id);
                const currentFollowUp = (entry.follow_up_state ?? "open") as "open" | "resolved";
                const isUpdating = updatingKey === entry.id;

                // Supersession chain references
                const supersededByEntry = entry.superseded_by ? entryById.get(entry.superseded_by) : null;
                const supersededEntries = (entry.supersedes ?? [])
                  .map((id) => entryById.get(id))
                  .filter(Boolean) as DecisionEntry[];

                return (
                  <div
                    key={entry.id}
                    className={`rounded-lg border p-4 transition-colors ${
                      isSuperseded
                        ? "border-[var(--border)] opacity-60"
                        : "border-[var(--border)]"
                    }`}
                  >
                    <div className="mb-2 flex items-center gap-2 flex-wrap">
                      <StatusBadge text={decisionLabel(st)} tone={toneForDecision(st)} />
                      {entry.scope && entry.scope !== "global" && (
                        <StatusBadge text={entry.scope_ref ?? entry.scope} tone="neutral" />
                      )}
                      {entry.confidence !== undefined && (
                        <span className="text-xs text-[var(--muted)]">conf {Math.round(entry.confidence * 100)}%</span>
                      )}
                      {entry.provenance?.linkType && (
                        <StatusBadge text={relationLabel(entry.provenance.linkType)} tone={relationTone(entry.provenance.linkType)} />
                      )}
                      <span className="text-xs text-[var(--muted)]">{timeAgo(entry.created_at ?? entry.ts)}</span>
                      {isSuperseded && (
                        <button
                          onClick={() => toggleSuperseded(entry.id)}
                          className="ml-auto text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                        >
                          {isExpanded ? "hide" : "show"}
                        </button>
                      )}
                    </div>

                    {/* Title (v2) or body fallback */}
                    {(!isSuperseded || isExpanded) && (
                      <>
                        {entry.title && entry.title !== (entry.body ?? entry.proposal) && (
                          <p className="mb-1 text-xs font-medium text-[var(--muted)] uppercase tracking-wide">{entry.title}</p>
                        )}
                        <p className="text-sm leading-relaxed">{entry.body ?? entry.proposal}</p>

                        {/* Rationale */}
                        {entry.rationale && (
                          <p className="mt-2 text-xs text-[var(--muted)] italic">{entry.rationale}</p>
                        )}

                        {/* Tags */}
                        {entry.tags && entry.tags.length > 0 && (
                          <div className="mt-2 flex gap-1 flex-wrap">
                            {entry.tags.map((tag) => (
                              <span key={tag} className="rounded bg-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">{tag}</span>
                            ))}
                          </div>
                        )}

                        {/* Supersession chain — this decision supersedes others */}
                        {supersededEntries.length > 0 && (
                          <div className="mt-3 rounded border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
                            <p className="mb-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">Supersedes</p>
                            {supersededEntries.map((s) => (
                              <p key={s.id} className="text-xs text-[var(--muted)] line-through">{s.title ?? s.body ?? s.proposal}</p>
                            ))}
                          </div>
                        )}

                        {/* Supersession chain — this decision is superseded by another */}
                        {supersededByEntry && (
                          <div className="mt-3 rounded border border-orange-900 bg-[var(--panel-2)] px-3 py-2">
                            <p className="mb-1 text-[10px] uppercase tracking-wider text-orange-400">Superseded by</p>
                            <p className="text-xs text-[var(--foreground)]">{supersededByEntry.title ?? supersededByEntry.body ?? supersededByEntry.proposal}</p>
                          </div>
                        )}

                        {/* Provenance link */}
                        {entry.provenance?.reviewItemId && (
                          <p className="mt-2 text-xs text-[var(--muted)]">from review item: {entry.provenance.reviewItemId}</p>
                        )}

                        {/* Follow-up controls — only for non-terminal statuses */}
                        {(st === "approved" || st === "deferred") && (
                          <div className="mt-3 flex flex-wrap gap-2 text-xs">
                            <button
                              onClick={() => setFollowUpState(entry, "open")}
                              disabled={isUpdating || currentFollowUp === "open"}
                              className="rounded border border-yellow-800 px-2 py-1 text-yellow-300 transition-colors hover:bg-yellow-950 disabled:opacity-40"
                            >
                              Mark open
                            </button>
                            <button
                              onClick={() => setFollowUpState(entry, "resolved")}
                              disabled={isUpdating || currentFollowUp === "resolved"}
                              className="rounded border border-green-800 px-2 py-1 text-green-300 transition-colors hover:bg-green-950 disabled:opacity-40"
                            >
                              Mark resolved
                            </button>
                          </div>
                        )}
                      </>
                    )}

                    {/* Collapsed superseded — show just the link to what replaced it */}
                    {isSuperseded && !isExpanded && supersededByEntry && (
                      <p className="text-xs text-[var(--muted)]">
                        → {supersededByEntry.title ?? supersededByEntry.body ?? supersededByEntry.proposal}
                      </p>
                    )}
                    {isSuperseded && !isExpanded && !supersededByEntry && entry.superseded_by && (
                      <p className="text-xs text-[var(--muted)]">superseded by {entry.superseded_by}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Provenance legend" tone="artifact">
          <div className="space-y-3 text-sm">
            <div><StatusBadge text="approved" tone="success" /> <span className="ml-2 text-[var(--muted)]">ratified, eligible for memory injection</span></div>
            <div><StatusBadge text="superseded" tone="neutral" /> <span className="ml-2 text-[var(--muted)]">replaced by a newer decision — collapsed by default</span></div>
            <div><StatusBadge text={relationLabel("direct-review")} tone={relationTone("direct-review")} /> <span className="ml-2 text-[var(--muted)]">decision explicitly derived from a review item</span></div>
            <div><StatusBadge text={relationLabel("context-derived")} tone={relationTone("context-derived")} /> <span className="ml-2 text-[var(--muted)]">decision contextually linked</span></div>
            <div><StatusBadge text="open" tone="warning" /> <span className="ml-2 text-[var(--muted)]">follow-up not yet resolved</span></div>
            <div><StatusBadge text="resolved" tone="success" /> <span className="ml-2 text-[var(--muted)]">follow-up resolved or processed</span></div>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
