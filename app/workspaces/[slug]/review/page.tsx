"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard, StackedBar, StatusBadge } from "../../../components/ui";
import { contextRelated, directDecisionLink, inferTextRelation, relationLabel, relationTone } from "../../../../lib/relations";
import { decisionLabel, timeAgo, toneForDecision } from "../../../../lib/utils";

type ReviewItem = {
  ts: string;
  reviewed: boolean;
  decision?: string;
  note?: string;
  reviewed_at?: string;
  project?: string;
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
  provenance?: {
    reviewItemId?: string;
    linkType?: string;
  };
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
  project?: string;
};


type Filter = "pending" | "reviewed" | "all";

export default function WorkspaceReviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const [slug, setSlug] = useState("");
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load(projectSlug: string) {
    setLoadError(null);
    try {
      const [reviewRes, decisionsRes, feedbackRes] = await Promise.all([
        fetch(`/api/review-queue?project=${projectSlug}`).then((r) => r.json()),
        fetch(`/api/decisions?project=${projectSlug}&limit=100`).then((r) => r.json()),
        fetch(`/api/feedback?project=${projectSlug}&limit=100`).then((r) => r.json()),
      ]);
      setItems(reviewRes.items ?? []);
      setDecisions(decisionsRes.entries ?? []);
      setFeedback(feedbackRes.entries ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load review data");
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
    await load(slug);
  }

  const filtered = items.filter((item) => {
    if (filter === "pending") return !item.reviewed;
    if (filter === "reviewed") return item.reviewed;
    return true;
  });

  const pendingCount = items.filter((i) => !i.reviewed).length;
  const reviewedCount = items.filter((i) => i.reviewed).length;
  const approvedCount = items.filter((i) => i.decision === "approve" || i.decision === "approved").length;
  const rejectedCount = items.filter((i) => i.decision === "reject" || i.decision === "rejected").length;
  const deferredCount = items.filter((i) => i.decision === "defer" || i.decision === "deferred").length;

  const activeItem = useMemo(
    () => filtered.find((item) => item.original_entry.id === activeId) ?? filtered[0] ?? null,
    [filtered, activeId],
  );

  const related = useMemo(() => {
    if (!activeItem) return null;
    const entry = activeItem.original_entry;

    const directDecisions = decisions.filter((decision) => directDecisionLink(decision, entry.id)).slice(0, 3);
    const contextDecisions = decisions.filter((decision) => contextRelated(decision, entry.context) && !directDecisions.find((d) => d.id === decision.id)).slice(0, 3);

    const contextFeedback = feedback.filter((feedbackEntry) => contextRelated(feedbackEntry, entry.context)).slice(0, 4);
    const inferredFeedback = feedback.filter((feedbackEntry) => inferTextRelation(feedbackEntry.body, entry.body) && !contextFeedback.find((d) => d.id === feedbackEntry.id)).slice(0, 4);

    return {
      directDecisions,
      contextDecisions,
      contextFeedback,
      inferredFeedback,
    };
  }, [activeItem, decisions, feedback]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (!activeItem || activeItem.reviewed || typing || submitting) return;
      if (event.key === "a") {
        event.preventDefault();
        decide(activeItem.original_entry.id, "approve");
      } else if (event.key === "r") {
        event.preventDefault();
        decide(activeItem.original_entry.id, "reject");
      } else if (event.key === "d") {
        event.preventDefault();
        decide(activeItem.original_entry.id, "defer");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeItem, submitting, note, slug]);

  if (loading) return <div className="text-[var(--muted)] text-sm">Loading…</div>;
  if (loadError) return <div className="p-8 text-sm text-red-400">Could not load review data: {loadError}</div>;

  return (
    <div>
      <PageHeader
        title={`Workspace Review · ${slug}`}
        description="Project-scoped review queue. Zelfde focusmodus als de hoofdreview, maar volledig gefilterd op deze workspace."
        actions={<Link href={`/workspaces/${slug}`} className="text-sm text-[var(--accent)] hover:underline">← dashboard</Link>}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <SectionCard title="Project review queue" tone="action">
          <div className="mb-5 flex gap-1 border-b border-[var(--border)]">
            {[
              { key: "pending", label: "Pending review", count: pendingCount },
              { key: "reviewed", label: "Handled", count: reviewedCount },
              { key: "all", label: "All", count: items.length },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => {
                  setFilter(tab.key as Filter);
                  setActiveId(null);
                }}
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

          <div className="mb-5">
            <StackedBar
              segments={[
                { label: "pending", value: pendingCount, tone: "warning" },
                { label: "approved", value: approvedCount, tone: "success" },
                { label: "rejected", value: rejectedCount, tone: "danger" },
                { label: "deferred", value: deferredCount, tone: "reflection" },
              ]}
            />
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No review items in this workspace for this filter.</p>
          ) : (
            <div className="space-y-3">
              {filtered.map((item) => {
                const id = item.original_entry.id;
                const selected = activeItem?.original_entry.id === id;
                return (
                  <button
                    key={id}
                    onClick={() => setActiveId(id)}
                    className={`block w-full rounded-lg border p-4 text-left transition-colors ${
                      selected ? "border-indigo-900 bg-[var(--panel-2)]" : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--panel-2)]"
                    }`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatusBadge text={item.original_entry.source} tone="accent" />
                        <StatusBadge text={item.original_entry.type} tone={item.original_entry.type === "proposal" ? "warning" : item.original_entry.type === "interpretation" ? "reflection" : "neutral"} />
                        <StatusBadge text={item.original_entry.context} tone="neutral" />
                        <span className="text-xs text-[var(--muted)]">{timeAgo(item.ts)}</span>
                      </div>
                      {item.reviewed && item.decision && <StatusBadge text={decisionLabel(item.decision)} tone={toneForDecision(item.decision)} />}
                    </div>
                    <p className="text-sm leading-relaxed">{item.original_entry.body}</p>
                  </button>
                );
              })}
            </div>
          )}
        </SectionCard>

        <div className="space-y-6 xl:sticky xl:top-6 xl:self-start">
          <SectionCard title="Selected item" tone="action">
            {!activeItem ? (
              <p className="text-sm text-[var(--muted)]">No item selected.</p>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge text={activeItem.original_entry.source} tone="accent" />
                  <StatusBadge text={activeItem.original_entry.type} tone={activeItem.original_entry.type === "proposal" ? "warning" : activeItem.original_entry.type === "interpretation" ? "reflection" : "neutral"} />
                  <StatusBadge text={activeItem.original_entry.context} tone="neutral" />
                  <span className="text-xs text-[var(--muted)]">{timeAgo(activeItem.ts)}</span>
                </div>
                <p className="text-sm leading-relaxed">{activeItem.original_entry.body}</p>
                {!activeItem.reviewed ? (
                  <div className="space-y-3 rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge text="a approve" tone="success" />
                      <StatusBadge text="r reject" tone="danger" />
                      <StatusBadge text="d defer" tone="warning" />
                    </div>
                    <input
                      type="text"
                      placeholder="Optionele notitie…"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder-[var(--muted)] focus:border-[var(--accent)] focus:outline-none"
                    />
                    <div className="sticky bottom-0 flex flex-wrap gap-2 rounded border border-[var(--border)] bg-[var(--surface)]/95 p-2 backdrop-blur">
                      {[
                        { key: "approve", label: "Approve", tone: "success" },
                        { key: "reject", label: "Reject", tone: "danger" },
                        { key: "defer", label: "Defer", tone: "warning" },
                      ].map((action) => (
                        <button
                          key={action.key}
                          onClick={() => decide(activeItem.original_entry.id, action.key)}
                          disabled={submitting}
                          className={`rounded border px-3 py-2 text-sm transition-colors disabled:opacity-40 ${
                            action.tone === "success"
                              ? "border-green-800 text-green-300 hover:bg-green-950"
                              : action.tone === "danger"
                                ? "border-red-800 text-red-300 hover:bg-red-950"
                                : "border-yellow-800 text-yellow-300 hover:bg-yellow-950"
                          }`}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <StatusBadge text={decisionLabel(activeItem.decision ?? "reviewed")} tone={toneForDecision(activeItem.decision)} />
                      {activeItem.reviewed_at && <span className="text-xs text-[var(--muted)]">{timeAgo(activeItem.reviewed_at)}</span>}
                    </div>
                    {activeItem.note ? <p className="text-sm text-[var(--muted)]">{activeItem.note}</p> : <p className="text-sm text-[var(--muted)]">No note for this decision.</p>}
                  </div>
                )}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Related context" tone="artifact">
            {!activeItem || !related ? (
              <p className="text-sm text-[var(--muted)]">Select an item to see related context.</p>
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="mb-2 text-xs uppercase tracking-wider text-[var(--muted)]">Decisions</p>
                  {related.directDecisions.length === 0 && related.contextDecisions.length === 0 ? (
                    <p className="text-xs text-[var(--muted)]">No linked decisions found.</p>
                  ) : (
                    <div className="space-y-2">
                      {related.directDecisions.map((decision) => (
                        <div key={`direct-${decision.id}`} className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
                          <div className="mb-1.5 flex items-center gap-2 flex-wrap">
                            <StatusBadge text={relationLabel("direct")} tone={relationTone("direct")} />
                            <StatusBadge text={decisionLabel(decision.decision)} tone={toneForDecision(decision.decision)} />
                            <StatusBadge text={decision.context} tone="neutral" />
                            <span className="text-xs text-[var(--muted)]">{timeAgo(decision.ts)}</span>
                          </div>
                          <p className="text-sm leading-relaxed">{decision.proposal}</p>
                        </div>
                      ))}
                      {related.contextDecisions.map((decision) => (
                        <div key={`context-${decision.id}`} className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
                          <div className="mb-1.5 flex items-center gap-2 flex-wrap">
                            <StatusBadge text={relationLabel("context-related")} tone={relationTone("context-related")} />
                            <StatusBadge text={decisionLabel(decision.decision)} tone={toneForDecision(decision.decision)} />
                            <StatusBadge text={decision.context} tone="neutral" />
                            <span className="text-xs text-[var(--muted)]">{timeAgo(decision.ts)}</span>
                          </div>
                          <p className="text-sm leading-relaxed">{decision.proposal}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <p className="mb-2 text-xs uppercase tracking-wider text-[var(--muted)]">Feedback</p>
                  {related.contextFeedback.length === 0 && related.inferredFeedback.length === 0 ? (
                    <p className="text-xs text-[var(--muted)]">No relevant feedback traces found.</p>
                  ) : (
                    <div className="space-y-2">
                      {related.contextFeedback.map((entry) => (
                        <div key={`context-${entry.id}`} className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
                          <div className="mb-1.5 flex items-center gap-2 flex-wrap">
                            <StatusBadge text={relationLabel("context-related")} tone={relationTone("context-related")} />
                            <StatusBadge text={entry.source} tone="accent" />
                            <StatusBadge text={entry.type} tone={entry.type === "proposal" ? "warning" : entry.type === "interpretation" ? "reflection" : "info"} />
                            <StatusBadge text={entry.context} tone="neutral" />
                          </div>
                          <p className="text-sm leading-relaxed">{entry.body}</p>
                        </div>
                      ))}
                      {related.inferredFeedback.map((entry) => (
                        <div key={`inferred-${entry.id}`} className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
                          <div className="mb-1.5 flex items-center gap-2 flex-wrap">
                            <StatusBadge text={relationLabel("inferred")} tone={relationTone("inferred")} />
                            <StatusBadge text={entry.source} tone="accent" />
                            <StatusBadge text={entry.type} tone={entry.type === "proposal" ? "warning" : entry.type === "interpretation" ? "reflection" : "info"} />
                            <StatusBadge text={entry.context} tone="neutral" />
                          </div>
                          <p className="text-sm leading-relaxed">{entry.body}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
