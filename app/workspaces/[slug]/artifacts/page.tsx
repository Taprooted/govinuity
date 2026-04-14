"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard, StatusBadge } from "../../../components/ui";
import { relationLabel, relationTone } from "../../../../lib/relations";
import { decisionLabel, timeAgo } from "../../../../lib/utils";

type DecisionEntry = {
  id: string;
  ts: string;
  decision: string;
  proposal: string;
  source: string;
  context: string;
  project?: string;
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
  loop_id?: string;
  project?: string;
};

type MemoryFile = {
  filename: string;
  type: string;
  name: string;
  description: string;
  content: string;
};

type ArtifactType = "all" | "decisions" | "feedback" | "memory";

type ViewMode = "list" | "grid";

export default function WorkspaceArtifactsPage({ params }: { params: Promise<{ slug: string }> }) {
  const [slug, setSlug] = useState("");
  const [artifactType, setArtifactType] = useState<ArtifactType>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [memory, setMemory] = useState<MemoryFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    params.then(async ({ slug }) => {
      setSlug(slug);
      try {
        const [decisionsRes, feedbackRes, memoryRes] = await Promise.all([
          fetch(`/api/decisions?project=${slug}&limit=100`).then((r) => r.json()),
          fetch(`/api/feedback?project=${slug}&limit=100`).then((r) => r.json()),
          fetch("/api/memory").then((r) => r.json()),
        ]);
        setDecisions(decisionsRes.entries ?? []);
        setFeedback(feedbackRes.entries ?? []);
        setMemory(memoryRes.files ?? []);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load artifacts");
      } finally {
        setLoading(false);
      }
    });
  }, [params]);

  const filteredMemory = useMemo(() => {
    return memory.filter((file) => {
      const haystack = `${file.name} ${file.description} ${file.content}`.toLowerCase();
      return haystack.includes(slug.toLowerCase());
    });
  }, [memory, slug]);

  const artifacts = useMemo(() => {
    const items: Array<{ id: string; kind: "decision" | "feedback" | "memory"; ts?: string; title: string; body: string; badges: Array<{ text: string; tone: "neutral" | "info" | "success" | "warning" | "danger" | "accent" | "reflection" }> }> = [];

    if (artifactType === "all" || artifactType === "decisions") {
      decisions.forEach((decision) => {
        items.push({
          id: `decision-${decision.id}`,
          kind: "decision",
          ts: decision.ts,
          title: decision.proposal,
          body: `Decision: ${decisionLabel(decision.decision)}`,
          badges: [
            { text: "decision", tone: "success" },
            { text: decision.context, tone: "neutral" },
            ...(decision.provenance?.linkType ? [{ text: relationLabel(decision.provenance.linkType), tone: relationTone(decision.provenance.linkType) }] : []),
          ],
        });
      });
    }

    if (artifactType === "all" || artifactType === "feedback") {
      feedback.forEach((entry) => {
        items.push({
          id: `feedback-${entry.id}`,
          kind: "feedback",
          ts: entry.ts,
          title: entry.body,
          body: `${entry.type}${entry.loop_id ? ` · ${entry.loop_id}` : ""}`,
          badges: [
            { text: "feedback", tone: entry.type === "proposal" ? "warning" : entry.type === "interpretation" ? "reflection" : "info" },
            { text: entry.context, tone: "neutral" },
          ],
        });
      });
    }

    if (artifactType === "all" || artifactType === "memory") {
      filteredMemory.forEach((file) => {
        items.push({
          id: `memory-${file.filename}`,
          kind: "memory",
          title: file.name,
          body: file.description,
          badges: [
            { text: "memory", tone: "accent" },
            { text: file.type, tone: "neutral" },
          ],
        });
      });
    }

    return items.sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  }, [artifactType, decisions, feedback, filteredMemory]);

  if (loadError) return <div className="p-8 text-sm text-red-400">Could not load artifacts: {loadError}</div>;

  return (
    <div>
      <PageHeader
        title={`Artifacts Board · ${slug}`}
        description="Project-scoped artifacts board over decisions, feedback en relevante memory-sporen. Zelfde data, maar nu onder projectlens in plaats van type-lens alleen."
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_260px]">
        <SectionCard title="Artifacts" tone="artifact">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {(["all", "decisions", "feedback", "memory"] as ArtifactType[]).map((type) => (
              <button
                key={type}
                onClick={() => setArtifactType(type)}
                className={`rounded border px-2 py-1 text-xs transition-colors ${artifactType === type ? "border-[var(--accent)] text-[var(--foreground)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}
              >
                {type}
              </button>
            ))}
            <div className="ml-auto flex gap-2">
              {(["list", "grid"] as ViewMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`rounded border px-2 py-1 text-xs transition-colors ${viewMode === mode ? "border-[var(--accent)] text-[var(--foreground)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"}`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-[var(--muted)]">Loading…</p>
          ) : artifacts.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No artifacts visible for this workspace.</p>
          ) : (
            <div className={viewMode === "grid" ? "grid grid-cols-1 gap-3 xl:grid-cols-2" : "space-y-3"}>
              {artifacts.map((artifact) => (
                <div key={artifact.id} className="rounded border border-[var(--border)] bg-[var(--surface)] p-3">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    {artifact.badges.map((badge) => (
                      <StatusBadge key={`${artifact.id}-${badge.text}`} text={badge.text} tone={badge.tone} />
                    ))}
                    {artifact.ts && <span className="text-xs text-[var(--muted)]">{timeAgo(artifact.ts)}</span>}
                  </div>
                  <p className="text-sm leading-relaxed">{artifact.title}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">{artifact.body}</p>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Workspace context" tone="artifact">
          <div className="space-y-3 text-sm text-[var(--muted)]">
            <p>This board is project-scoped. It bundles decisions, feedback, and memory traces within one workspace.</p>
            <div className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
              <p className="text-xs uppercase tracking-wider text-[var(--muted)]">Filters</p>
              <p className="mt-1">Use the type filter to quickly switch between the decision log, feedback traces, and memory.</p>
            </div>
            <div className="rounded border border-[var(--border)] bg-[var(--panel-2)] p-3">
              <p className="text-xs uppercase tracking-wider text-[var(--muted)]">Links</p>
              <div className="mt-2 flex flex-col gap-2 text-xs">
                <Link href={`/workspaces/${slug}/review`} className="text-[var(--accent)] hover:underline">workspace review</Link>
                <Link href={`/workspaces/${slug}/decisions`} className="text-[var(--accent)] hover:underline">decision log</Link>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
