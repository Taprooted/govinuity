"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MetricTile, PageHeader, SectionCard, StatusBadge } from "../../components/ui";
import { timeAgo, toneForDecision } from "../../../lib/utils";

type ProjectPageData = {
  project: {
    slug: string;
    name: string;
    color: string;
    description: string;
    status?: string;
  };
  counts: {
    feedback: number;
    decisions: number;
    review: number;
    pendingReview: number;
    openFollowUps: number;
  };
  lastActivityTs: string | null;
  samples: {
    recentFeedback: Array<{ id: string; type: string; context: string; body: string }>;
    recentDecisions: Array<{ id: string; decision: string; proposal: string; ts: string; follow_up_state?: string; provenance?: { linkType?: string } }>;
    pendingReview: Array<{ original_entry: { id: string; source: string; context: string; body: string } }>;
    openFollowUps: Array<{ id: string; decision: string; proposal: string; ts: string; follow_up_state?: string; provenance?: { linkType?: string } }>;
  };
};

export default function WorkspaceDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const [slug, setSlug] = useState<string>("");
  const [data, setData] = useState<ProjectPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    params
      .then(({ slug }) => {
        if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
          throw new Error("Invalid workspace slug");
        }
        setSlug(slug);
        return fetch(`/api/projects/${slug}`).then(async (r) => {
          if (!r.ok) throw new Error(r.status === 404 ? "Workspace not found" : "Could not load workspace");
          return r.json();
        });
      })
      .then((projectJson) => {
        setData(projectJson);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err.message || err));
        setLoading(false);
      });
  }, [params]);

  if (loading) return <div className="text-[var(--muted)] text-sm">Loading…</div>;
  if (error) return <div className="text-sm text-red-300">{error}</div>;
  if (!data) return <div className="text-[var(--muted)] text-sm">No workspace data.</div>;

  const needsAttention = [
    data.counts.pendingReview > 0
      ? { label: `${data.counts.pendingReview} open review-item${data.counts.pendingReview === 1 ? "" : "s"}`, href: `/workspaces/${slug}/review` }
      : null,
    data.counts.openFollowUps > 0
      ? { label: `${data.counts.openFollowUps} open follow-up${data.counts.openFollowUps === 1 ? "" : "s"}`, href: `/workspaces/${slug}/decisions` }
      : null,
    data.samples.recentDecisions.length > 0
      ? { label: `${data.samples.recentDecisions.length} recent decisions`, href: `/workspaces/${slug}/decisions` }
      : null,
  ].filter(Boolean) as { label: string; href: string }[];

  return (
    <div className="space-y-6">
      <PageHeader
        title={data.project.name}
        description={data.project.description}
        actions={<StatusBadge text={data.project.status ?? "active"} tone="success" />}
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricTile label="Open review" value={data.counts.pendingReview} tone={data.counts.pendingReview > 0 ? "warning" : "neutral"} />
        <MetricTile label="Open follow-ups" value={data.counts.openFollowUps} tone={data.counts.openFollowUps > 0 ? "accent" : "neutral"} />
        <MetricTile label="Decisions" value={data.counts.decisions} tone={data.counts.decisions > 0 ? "success" : "neutral"} />
        <MetricTile label="Last activity" value={timeAgo(data.lastActivityTs)} tone="neutral" />
      </div>

      <SectionCard title="What needs attention" tone="action">
        {needsAttention.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No open items in this workspace.</p>
        ) : (
          <div className="space-y-2">
            {needsAttention.map((item, i) => (
              <Link key={item.href} href={item.href} className="flex items-center gap-3 rounded border border-[var(--border)] p-3 transition-colors hover:bg-[var(--panel-2)]">
                <StatusBadge text={`prio ${i + 1}`} tone={i === 0 ? "danger" : "neutral"} />
                <span className="text-sm">{item.label}</span>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <SectionCard title="Open review items" tone="action" action={<Link href={`/workspaces/${slug}/review`} className="text-xs text-[var(--accent)] hover:underline">project review</Link>}>
          {data.samples.pendingReview.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No open review items.</p>
          ) : (
            <div className="space-y-2">
              {data.samples.pendingReview.map((item) => (
                <div key={item.original_entry.id} className="rounded border border-[var(--border)] p-3">
                  <div className="mb-1.5 flex items-center gap-2 flex-wrap">
                    <StatusBadge text={item.original_entry.source} tone="accent" />
                    <StatusBadge text={item.original_entry.context} tone="neutral" />
                  </div>
                  <p className="text-sm leading-relaxed">{item.original_entry.body}</p>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Recent decisions" tone="artifact" action={<Link href={`/workspaces/${slug}/decisions`} className="text-xs text-[var(--accent)] hover:underline">decision log</Link>}>
          {data.samples.recentDecisions.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No decisions yet for this workspace.</p>
          ) : (
            <div className="space-y-2">
              {data.samples.recentDecisions.map((decision) => (
                <div key={decision.id} className="rounded border border-[var(--border)] p-3">
                  <div className="mb-1.5 flex items-center gap-2 flex-wrap">
                    <StatusBadge text={decision.decision} tone={toneForDecision(decision.decision)} />
                    <StatusBadge text={decision.follow_up_state ?? "open"} tone={(decision.follow_up_state ?? "open") === "open" ? "warning" : "success"} />
                    {decision.provenance?.linkType && <StatusBadge text={decision.provenance.linkType} tone="neutral" />}
                  </div>
                  <p className="text-sm leading-relaxed">{decision.proposal}</p>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Open follow-ups" tone="action" action={<Link href={`/workspaces/${slug}/decisions`} className="text-xs text-[var(--accent)] hover:underline">decision log</Link>}>
          {data.samples.openFollowUps.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No open follow-ups in this workspace.</p>
          ) : (
            <div className="space-y-2">
              {data.samples.openFollowUps.map((decision) => (
                <div key={`${decision.id}-${decision.ts}`} className="rounded border border-[var(--border)] p-3">
                  <div className="mb-1.5 flex items-center gap-2 flex-wrap">
                    <StatusBadge text={decision.decision} tone={toneForDecision(decision.decision)} />
                    <StatusBadge text={decision.follow_up_state ?? "open"} tone="warning" />
                  </div>
                  <p className="text-sm leading-relaxed">{decision.proposal}</p>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Recent feedback" tone="artifact" action={<Link href={`/workspaces/${slug}/artifacts`} className="text-xs text-[var(--accent)] hover:underline">artifacts</Link>}>
          {data.samples.recentFeedback.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No recent feedback.</p>
          ) : (
            <div className="space-y-2">
              {data.samples.recentFeedback.map((entry) => (
                <div key={entry.id} className="rounded border border-[var(--border)] p-3">
                  <div className="mb-1.5 flex items-center gap-2 flex-wrap">
                    <StatusBadge text={entry.type} tone={entry.type === "proposal" ? "warning" : entry.type === "interpretation" ? "reflection" : "info"} />
                    <StatusBadge text={entry.context} tone="neutral" />
                  </div>
                  <p className="text-sm leading-relaxed">{entry.body}</p>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
