"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard, StackedBar, StatusBadge } from "../components/ui";
import { contextRelated, directDecisionLink, inferTextRelation, relationLabel, relationTone } from "../../lib/relations";
import { decisionLabel, timeAgo, toneForDecision } from "../../lib/utils";

type DecisionEntry = {
  ts: string;
  id: string;
  decision: string;
  proposal: string;
  source: string;
  context: string;
  note?: string;
  reviewed_by?: string;
  follow_up_state?: string;
  provenance?: {
    reviewItemId?: string;
    linkType?: string;
    decidedAt?: string;
    derivedFrom?: string[];
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
};

type MemoryFile = {
  filename: string;
  type: string;
  name: string;
  description: string;
  content: string;
};


type Tab = "decisions" | "feedback" | "memory";

export default function ArtifactsPage() {
  const [tab, setTab] = useState<Tab>("decisions");
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [memory, setMemory] = useState<MemoryFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedMemory, setExpandedMemory] = useState<string | null>(null);
  const [feedbackTypeFilter, setFeedbackTypeFilter] = useState<string>("all");
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  async function setFollowUpState(decision: DecisionEntry, state: "open" | "resolved") {
    setClosingId(decision.id);
    await fetch("/api/decisions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: decision.id, ts: decision.ts, follow_up_state: state }),
    });
    setDecisions((prev) =>
      prev.map((d) => (d.id === decision.id && d.ts === decision.ts ? { ...d, follow_up_state: state } : d)),
    );
    setClosingId(null);
  }

  async function loadTab(t: Tab) {
    setLoading(true);
    setLoadError(null);
    try {
      const [decisionsRes, feedbackRes, memoryRes] = await Promise.all([
        fetch("/api/decisions?limit=50").then((r) => r.json()),
        fetch("/api/feedback?limit=50").then((r) => r.json()),
        fetch("/api/memory").then((r) => r.json()),
      ]);
      setDecisions(decisionsRes.entries ?? []);
      setFeedback(feedbackRes.entries ?? []);
      setMemory(memoryRes.files ?? []);
      if (t !== "decisions") setSelectedDecisionId(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load artifacts");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTab(tab);
  }, [tab]);

  const feedbackTypes = ["all", ...Array.from(new Set(feedback.map((e) => e.type)))];
  const filteredFeedback = feedbackTypeFilter === "all" ? feedback : feedback.filter((e) => e.type === feedbackTypeFilter);

  const tabs: { key: Tab; label: string }[] = [
    { key: "decisions", label: "Decisions" },
    { key: "feedback", label: "Feedback log" },
    { key: "memory", label: "Memory" },
  ];

  const approvedCount = decisions.filter((d) => d.decision === "approve" || d.decision === "approved").length;
  const rejectedCount = decisions.filter((d) => d.decision === "reject" || d.decision === "rejected").length;
  const deferredCount = decisions.filter((d) => d.decision === "defer" || d.decision === "deferred").length;

  const observationCount = feedback.filter((f) => f.type === "observation").length;
  const interpretationCount = feedback.filter((f) => f.type === "interpretation").length;
  const proposalCount = feedback.filter((f) => f.type === "proposal").length;

  const selectedDecision = useMemo(
    () => decisions.find((entry) => entry.id === selectedDecisionId) ?? decisions[0] ?? null,
    [decisions, selectedDecisionId],
  );


  const relatedForDecision = useMemo(() => {
    if (!selectedDecision) return null;
    const directFeedback = feedback.filter((entry) => contextRelated(entry, selectedDecision.context)).slice(0, 4);
    const proposalSnippet = selectedDecision.proposal?.slice(0, 20) ?? "";
    const inferredFeedback = proposalSnippet
      ? feedback.filter((entry) => entry.body?.includes(proposalSnippet) && !directFeedback.find((d) => d.id === entry.id)).slice(0, 4)
      : [];
    return { directFeedback, inferredFeedback };
  }, [selectedDecision, feedback]);

  if (loadError) return <div className="p-8 text-sm text-red-400">Could not load artifacts: {loadError}</div>;

  return (
    <div>
      <PageHeader
        title="Artifacts"
        description="Navigable history of decisions, feedback and memory. Less log dump, more context layer for where something came from and where it led."
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <SectionCard title="Artifacts" tone="artifact">
          <div className="mb-6 flex gap-1 border-b border-[var(--border)]">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                  tab === t.key
                    ? "border-[var(--accent)] text-[var(--foreground)]"
                    : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {loading && <div className="text-sm text-[var(--muted)]">Loading…</div>}

          {!loading && tab === "decisions" && (
            <div className="space-y-3">
              {decisions.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No decisions found.</p>
              ) : (
                decisions.map((entry) => {
                  const selected = selectedDecision?.id === entry.id;
                  return (
                    <button
                      key={entry.id ?? entry.ts}
                      onClick={() => setSelectedDecisionId(entry.id)}
                      className={`block w-full rounded-lg border p-4 text-left transition-colors ${selected ? "border-indigo-900 bg-[var(--panel-2)]" : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--panel-2)]"}`}
                    >
                      <div className="mb-2 flex items-start justify-between gap-4">
                        <div className="flex items-center gap-2 flex-wrap">
                          <StatusBadge text={entry.source} tone="accent" />
                          <StatusBadge text={entry.context} tone="neutral" />
                          {entry.provenance?.linkType === "direct-review" && <StatusBadge text="direct linked" tone="success" />}
                          {entry.provenance?.linkType === "context-derived" && <StatusBadge text="context related" tone="warning" />}
                          <span className="text-xs text-[var(--muted)]">{timeAgo(entry.ts)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge text={decisionLabel(entry.decision)} tone={toneForDecision(entry.decision)} />
                          {(entry.follow_up_state ?? "open") === "open"
                            ? <StatusBadge text="follow-up open" tone="warning" />
                            : <StatusBadge text="resolved" tone="success" />}
                        </div>
                      </div>
                      <p className="text-sm leading-relaxed">{entry.proposal}</p>
                      {entry.note && <p className="mt-2 text-xs italic text-[var(--muted)]">"{entry.note}"</p>}
                    </button>
                  );
                })
              )}
            </div>
          )}

          {!loading && tab === "feedback" && (
            <div>
              <div className="mb-4 flex gap-2 flex-wrap">
                {feedbackTypes.map((t) => (
                  <button
                    key={t}
                    onClick={() => setFeedbackTypeFilter(t)}
                    className={`rounded border px-2 py-1 text-xs transition-colors ${
                      feedbackTypeFilter === t
                        ? "border-[var(--accent)] text-[var(--foreground)]"
                        : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="space-y-3">
                {filteredFeedback.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No entries found.</p>
                ) : (
                  filteredFeedback.map((entry, idx) => (
                    <div key={`${entry.id}-${idx}`} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
                      <div className="mb-2 flex items-center gap-2 flex-wrap">
                        <StatusBadge text={entry.source} tone="accent" />
                        <StatusBadge text={entry.type} tone={entry.type === "proposal" ? "warning" : entry.type === "interpretation" ? "reflection" : "info"} />
                        <StatusBadge text={entry.context} tone="neutral" />
                        {entry.severity && <StatusBadge text={entry.severity} tone="neutral" />}
                        {entry.loop_id && <StatusBadge text={entry.loop_id} tone="info" />}
                        <span className="text-xs text-[var(--muted)]">{timeAgo(entry.ts)}</span>
                      </div>
                      <p className="text-sm leading-relaxed">{entry.body}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {!loading && tab === "memory" && (
            <div className="space-y-2">
              {memory.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No memory files found.</p>
              ) : (
                memory.map((file) => {
                  const isExpanded = expandedMemory === file.filename;
                  const body = file.content.replace(/^---[\s\S]*?---\n?/, "").trim();
                  return (
                    <div key={file.filename} className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
                      <button
                        onClick={() => setExpandedMemory(isExpanded ? null : file.filename)}
                        className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-[var(--panel-2)]"
                      >
                        <StatusBadge text={file.type} tone={file.type === "project" ? "info" : file.type === "user" ? "success" : file.type === "feedback" ? "warning" : "reflection"} />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{file.name}</p>
                          <p className="truncate text-xs text-[var(--muted)]">{file.description}</p>
                        </div>
                        <span className="shrink-0 text-xs text-[var(--muted)]">{isExpanded ? "▲" : "▼"}</span>
                      </button>
                      {isExpanded && (
                        <div className="border-t border-[var(--border)] px-4 pb-4">
                          <pre className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-[var(--muted)]">{body}</pre>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </SectionCard>

        <SectionCard title={tab === "decisions" ? "Related context" : "Snapshot"} tone="artifact">
          {tab === "decisions" && selectedDecision ? (
            <div className="space-y-5">
              <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3">
                <div className="mb-2 flex items-center gap-2 flex-wrap">
                  <StatusBadge text={decisionLabel(selectedDecision.decision)} tone={toneForDecision(selectedDecision.decision)} />
                  <StatusBadge text={selectedDecision.context} tone="neutral" />
                  {selectedDecision.provenance?.linkType === "direct-review" && <StatusBadge text="came from review" tone="success" />}
                  {selectedDecision.provenance?.reviewItemId && <StatusBadge text={selectedDecision.provenance.reviewItemId} tone="neutral" />}
                </div>
                <p className="mb-3 text-sm leading-relaxed">{selectedDecision.proposal}</p>
                <div className="flex items-center gap-2">
                  {(selectedDecision.follow_up_state ?? "open") === "open" ? (
                    <>
                      <StatusBadge text="follow-up open" tone="warning" />
                      <button
                        onClick={() => setFollowUpState(selectedDecision, "resolved")}
                        disabled={closingId === selectedDecision.id}
                        className="rounded border border-green-800 px-2 py-1 text-xs text-green-300 transition-colors hover:bg-green-950 disabled:opacity-40"
                      >
                        {closingId === selectedDecision.id ? "…" : "Resolved"}
                      </button>
                    </>
                  ) : (
                    <>
                      <StatusBadge text="resolved" tone="success" />
                      <button
                        onClick={() => setFollowUpState(selectedDecision, "open")}
                        disabled={closingId === selectedDecision.id}
                        className="rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] transition-colors hover:border-yellow-800 hover:text-yellow-300 disabled:opacity-40"
                      >
                        {closingId === selectedDecision.id ? "…" : "Reopen"}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs uppercase tracking-wider text-[var(--muted)]">Direct feedback links</p>
                {relatedForDecision && relatedForDecision.directFeedback.length > 0 ? (
                  <div className="space-y-2">
                    {relatedForDecision.directFeedback.map((entry, idx) => (
                      <div key={`${entry.id}-${idx}`} className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
                        <div className="mb-1.5 flex items-center gap-2 flex-wrap">
                          <StatusBadge text="direct" tone="success" />
                          <StatusBadge text={entry.type} tone={entry.type === "proposal" ? "warning" : entry.type === "interpretation" ? "reflection" : "info"} />
                          <StatusBadge text={entry.context} tone="neutral" />
                        </div>
                        <p className="text-sm leading-relaxed">{entry.body}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-[var(--muted)]">No direct feedback links found.</p>
                )}
              </div>
              <div>
                <p className="mb-2 text-xs uppercase tracking-wider text-[var(--muted)]">Inferred / context-related feedback</p>
                {relatedForDecision && relatedForDecision.inferredFeedback.length > 0 ? (
                  <div className="space-y-2">
                    {relatedForDecision.inferredFeedback.map((entry, idx) => (
                      <div key={`${entry.id}-${idx}`} className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
                        <div className="mb-1.5 flex items-center gap-2 flex-wrap">
                          <StatusBadge text="inferred" tone="warning" />
                          <StatusBadge text={entry.type} tone={entry.type === "proposal" ? "warning" : entry.type === "interpretation" ? "reflection" : "info"} />
                          <StatusBadge text={entry.context} tone="neutral" />
                        </div>
                        <p className="text-sm leading-relaxed">{entry.body}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-[var(--muted)]">No inferred feedback traces found.</p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <p className="mb-2 text-xs uppercase tracking-wider text-[var(--muted)]">Decision status</p>
                <StackedBar
                  segments={[
                    { label: "approved", value: approvedCount, tone: "success" },
                    { label: "rejected", value: rejectedCount, tone: "danger" },
                    { label: "deferred", value: deferredCount, tone: "warning" },
                  ]}
                />
              </div>
              <div>
                <p className="mb-2 text-xs uppercase tracking-wider text-[var(--muted)]">Feedback composition</p>
                <StackedBar
                  segments={[
                    { label: "observation", value: observationCount, tone: "info" },
                    { label: "interpretation", value: interpretationCount, tone: "reflection" },
                    { label: "proposal", value: proposalCount, tone: "warning" },
                  ]}
                />
              </div>
              <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-3 text-sm text-[var(--muted)]">
                Artifacts should primarily help connect: what was decided, what feedback preceded it, and which memory trace is relevant.
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
