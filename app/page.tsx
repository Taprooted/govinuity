"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MetricTile, PageHeader, ProjectBar, SectionCard, StatusBadge } from "./components/ui";
import { timeAgo } from "../lib/utils";

type Decision = {
  id: string;
  title?: string;
  body: string;
  summary_for_human?: string;
  proposal_class?: string;
  created_at?: string;
  ts?: string;
};

type Metrics = {
  runs: { last_7d: number; last_30d: number };
  averages: {
    injected_per_run: number | null;
    excluded_per_run: number | null;
    duration_ms: number | null;
    eligible_per_run: number | null;
  };
  exclusion_reasons: Record<string, number>;
  decision_utilization: { decision_id: string; title: string | null; injection_count: number }[];
  runs_by_day: { date: string; count: number }[];
  decision_health: { approved: number; proposed: number; deferred: number; superseded: number };
};

const CLASS_LABELS: Record<string, string> = {
  architectural_decision: "Architecture",
  durable_workflow_rule:  "Workflow",
  scoped_exception:       "Exception",
  durable_constraint:     "Constraint",
  workflow_rule:              "Workflow",
  scoped_implementation_rule: "Implementation",
  release_or_ops_config:      "Ops/Config",
};

function OutcomeStrip({ byType }: { byType: Record<string, number> }) {
  const failures = (byType["context_restatement_required"] ?? 0)
    + (byType["continuity_correction_required"] ?? 0)
    + (byType["stale_leakage_detected"] ?? 0);
  const followed    = byType["approved_decision_followed"] ?? 0;
  const notFollowed = byType["approved_decision_not_followed"] ?? 0;
  const total = failures + followed + notFollowed;

  if (total === 0) return null;

  const successRate = followed + notFollowed > 0
    ? Math.round((followed / (followed + notFollowed)) * 100)
    : null;

  return (
    <SectionCard title="Continuity outcomes">
      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* Failure signals */}
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wider text-[var(--muted)]">Failure signals</p>
          {[
            { key: "context_restatement_required", label: "Context restated" },
            { key: "continuity_correction_required", label: "Correction required" },
            { key: "stale_leakage_detected", label: "Stale leakage" },
          ].map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between text-xs">
              <span className={`text-[var(--muted)] ${byType[key] ? "text-[var(--brand-gold)]" : ""}`}>{label}</span>
              <span className={`font-semibold tabular-nums ${byType[key] ? (key === "stale_leakage_detected" ? "text-[var(--brand-coral)]" : "text-[var(--brand-gold)]") : "text-[var(--muted)]"}`}>
                {byType[key] ?? 0}
              </span>
            </div>
          ))}
        </div>

        {/* Decision adherence */}
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wider text-[var(--muted)]">Decision adherence</p>
          <div className="flex items-center justify-between text-xs">
            <span className={followed > 0 ? "text-[var(--brand-green)]" : "text-[var(--muted)]"}>Followed</span>
            <span className={`font-semibold tabular-nums ${followed > 0 ? "text-[var(--brand-green)]" : "text-[var(--muted)]"}`}>{followed}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className={notFollowed > 0 ? "text-[var(--brand-coral)]" : "text-[var(--muted)]"}>Not followed</span>
            <span className={`font-semibold tabular-nums ${notFollowed > 0 ? "text-[var(--brand-coral)]" : "text-[var(--muted)]"}`}>{notFollowed}</span>
          </div>
          {successRate !== null && (
            <div className="pt-1 border-t border-[var(--border)] flex items-center justify-between text-xs">
              <span className="text-[var(--muted)]">Adherence rate</span>
              <span className={`font-semibold tabular-nums ${successRate >= 75 ? "text-[var(--brand-green)]" : successRate >= 50 ? "text-[var(--brand-gold)]" : "text-[var(--brand-coral)]"}`}>
                {successRate}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Total failures bar */}
      {failures > 0 && (
        <div className="pt-2 border-t border-[var(--border)] flex items-center gap-2 text-xs text-[var(--muted)]">
          <span className="text-[var(--brand-gold)] font-semibold">{failures}</span>
          <span>failure signal{failures !== 1 ? "s" : ""} in total —</span>
          <Link href="/runs" className="text-[var(--accent)] hover:underline">annotate runs</Link>
          <span>to refine</span>
        </div>
      )}
    </SectionCard>
  );
}

function SparkBar({ data }: { data: { date: string; count: number }[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="flex items-end gap-0.5 h-8">
      {data.map((d) => (
        <div
          key={d.date}
          className="flex-1 rounded-sm bg-[var(--brand-gold)] opacity-65 transition-opacity hover:opacity-90"
          style={{ height: `${Math.max((d.count / max) * 100, d.count > 0 ? 8 : 2)}%` }}
          title={`${d.date}: ${d.count} run${d.count !== 1 ? "s" : ""}`}
        />
      ))}
    </div>
  );
}

type HarvestMeta = { running: boolean; started_at?: string; last_run_ts?: string; last_submitted?: number; last_annotations?: number };

export default function HomePage() {
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [pendingReview, setPendingReview] = useState(0);
  const [ratifiedCount, setRatifiedCount] = useState(0);
  const [recentDecisions, setRecentDecisions] = useState<Decision[]>([]);
  const [metrics, setMetrics]           = useState<Metrics | null>(null);
  const [annotationsByType, setAnnotationsByType] = useState<Record<string, number>>({});
  const [loading, setLoading]           = useState(true);
  const [loadError, setLoadError]       = useState<string | null>(null);
  const [harvestMeta, setHarvestMeta]   = useState<HarvestMeta | null>(null);
  const [harvesting, setHarvesting]     = useState(false);
  const [harvestResult, setHarvestResult] = useState<{ submitted: number; annotations: number } | null>(null);
  const [seeding, setSeeding]           = useState(false);
  const [seedDone, setSeedDone]         = useState(false);

  async function load(project: string | null = null) {
    setLoadError(null);
    const proj = project ? `?project=${project}` : "";
    try {
      const [reviewData, decisionsData, metricsData, annotData] = await Promise.all([
        fetch("/api/review-queue").then((r) => r.json()),
        fetch("/api/decisions?status=approved&limit=500").then((r) => r.json()),
        fetch(`/api/metrics${proj}`).then((r) => r.json()),
        fetch("/api/run-annotations?limit=2000").then((r) => r.json()),
      ]);
      setPendingReview((reviewData.items ?? []).filter((i: { reviewed: boolean }) => !i.reviewed).length);
      const entries: Decision[] = decisionsData.entries ?? [];
      setRatifiedCount(entries.length);
      setRecentDecisions(entries.slice(0, 4));
      setMetrics(metricsData);
      setAnnotationsByType(annotData.by_type ?? {});
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    fetch("/api/harvest").then((r) => r.json()).then((d) => {
      const m = d.meta ?? { running: false };
      setHarvestMeta(m);
      if (m.running) setHarvesting(true);
    });
  }, []);

  // Poll while harvesting (survives navigation)
  useEffect(() => {
    if (!harvesting) return;
    const poll = setInterval(() => {
      fetch("/api/harvest").then((r) => r.json()).then((d) => {
        const m = d.meta ?? { running: false };
        setHarvestMeta(m);
        if (!m.running) {
          setHarvesting(false);
          setHarvestResult({ submitted: m.last_submitted ?? 0, annotations: m.last_annotations ?? 0 });
          load(activeProject);
          clearInterval(poll);
        }
      });
    }, 3_000);
    return () => clearInterval(poll);
  }, [harvesting]);

  async function seedData() {
    setSeeding(true);
    const res = await fetch("/api/seed", { method: "POST" });
    const data = await res.json();
    setSeeding(false);
    if (res.ok && data.ok) {
      setSeedDone(true);
      load(activeProject);
    }
  }

  async function runHarvest() {
    setHarvesting(true);
    setHarvestResult(null);
    const res = await fetch("/api/harvest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hours: 48 }),
    });
    const data = await res.json();
    setHarvesting(false);
    if (res.ok && data.ok) {
      setHarvestResult({ submitted: data.submitted, annotations: data.annotations });
      setHarvestMeta(await fetch("/api/harvest").then((r) => r.json()).then((d) => d.meta ?? null));
      load(activeProject);
    }
  }

  function handleProjectSelect(p: string | null) {
    setActiveProject(p);
    load(p);
  }

  if (loading) return <div className="text-[var(--muted)] text-sm">Loading…</div>;
  if (loadError) return <div className="p-8 text-sm text-[var(--brand-coral)]">Could not load dashboard: {loadError}</div>;

  const injRate = metrics?.averages.injected_per_run;
  const eligRate = metrics?.averages.eligible_per_run;
  const injectionEfficiency =
    injRate != null && eligRate != null && eligRate > 0
      ? Math.round((injRate / eligRate) * 100)
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Governance pulse: what needs attention, what has been ratified."
      />

      <ProjectBar activeProject={activeProject} onSelect={handleProjectSelect} />

      {/* Harvest bar */}
      <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
        <button
          onClick={runHarvest}
          disabled={harvesting}
          className="rounded bg-[var(--brand-green)] px-3 py-1 text-xs text-white transition-opacity hover:opacity-85 disabled:opacity-40 shrink-0"
        >
          {harvesting ? "Harvesting…" : "Harvest sessions"}
        </button>
        <span className="text-xs text-[var(--muted)]">
          {harvestResult
            ? harvestResult.submitted > 0 || harvestResult.annotations > 0
              ? `Harvest complete · ${harvestResult.submitted} proposals surfaced · ${harvestResult.annotations} outcome signals logged`
              : "Harvest complete · no qualifying proposals or outcome signals found"
            : harvestMeta?.last_run_ts
            ? `Last harvest ${timeAgo(harvestMeta.last_run_ts)} · ${harvestMeta.last_submitted ?? 0} proposals surfaced`
            : "Surface candidate decisions from recent agent session files"}
        </span>
        <Link href="/harvest" className="ml-auto text-xs text-[var(--muted)] hover:text-[var(--foreground)] shrink-0">
          Harvest settings →
        </Link>
      </div>

      {/* Core governance metrics */}
      <div className="grid grid-cols-3 gap-3">
        <Link href="/review">
          <MetricTile label="Pending review" value={pendingReview} tone={pendingReview > 0 ? "warning" : "neutral"} />
        </Link>
        <Link href="/decisions">
          <MetricTile label="Decisions" value={ratifiedCount} tone="neutral" />
        </Link>
        <Link href="/runs">
          <MetricTile label="Runs" value={metrics?.runs.last_30d ?? 0} tone="neutral" />
        </Link>
      </div>

      {/* Outcome signals — primary evaluation view */}
      <OutcomeStrip byType={annotationsByType} />

      {/* Injection metrics strip */}
      {metrics && metrics.runs.last_30d > 0 && (
        <SectionCard title="Continuity runs — last 30 days">
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div>
              <p className="text-xs text-[var(--muted)]">Runs (7d)</p>
              <p className="text-xl font-semibold tabular-nums">{metrics.runs.last_7d}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)]">Ø injected</p>
              <p className="text-xl font-semibold tabular-nums">
                {injRate != null ? injRate.toFixed(1) : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)]">Injection efficiency</p>
              <p className="text-xl font-semibold tabular-nums">
                {injectionEfficiency != null ? `${injectionEfficiency}%` : "—"}
              </p>
            </div>
          </div>

          {/* Sparkbar — runs per day */}
          {metrics.runs_by_day.length > 0 && (
            <div className="mb-4">
              <p className="text-xs text-[var(--muted)] mb-1.5">Runs per day (14d)</p>
              <SparkBar data={metrics.runs_by_day} />
            </div>
          )}

          {/* Top injected decisions */}
          {metrics.decision_utilization.length > 0 && (
            <div>
              <p className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">Most injected decisions</p>
              <div className="space-y-1">
                {metrics.decision_utilization.slice(0, 5).map((d) => (
                  <div key={d.decision_id} className="flex items-center justify-between text-xs gap-2">
                    <span className="text-[var(--foreground)] truncate">
                      {d.title ?? d.decision_id}
                    </span>
                    <span className="shrink-0 font-mono text-[var(--brand-gold)]">{d.injection_count}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Exclusion reasons — only if any */}
          {Object.keys(metrics.exclusion_reasons).length > 0 && (
            <div className="mt-3 pt-3 border-t border-[var(--border)]">
              <p className="text-xs text-[var(--muted)] uppercase tracking-wider mb-1.5">Exclusion reasons</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(metrics.exclusion_reasons).map(([reason, count]) => (
                  <span key={reason} className="text-xs">
                    <span className="font-mono text-[var(--muted)]">{reason}</span>
                    <span className="ml-1 font-semibold">{count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </SectionCard>
      )}

      {/* Recent decisions — memory layer preview */}
      {recentDecisions.length > 0 && (
        <SectionCard
          title="Recent decisions"
          tone="artifact"
          action={
            <Link href="/decisions" className="text-xs text-[var(--accent)] hover:underline">
              All decisions
            </Link>
          }
        >
          <div className="space-y-2">
            {recentDecisions.map((d) => {
              const title = d.title || d.body.split("\n")[0].slice(0, 100);
              const classLabel = d.proposal_class ? (CLASS_LABELS[d.proposal_class] ?? d.proposal_class) : null;
              const ts = d.created_at ?? d.ts;
              return (
                <div key={d.id} className="rounded border border-[var(--border)] px-3 py-2.5">
                  <div className="mb-1 flex items-center gap-2">
                    {classLabel && <StatusBadge text={classLabel} tone="neutral" />}
                    {ts && <span className="ml-auto text-xs text-[var(--muted)]">{timeAgo(ts)}</span>}
                  </div>
                  <p className="text-sm font-medium">{title}</p>
                  {d.summary_for_human && (
                    <p className="mt-0.5 text-xs text-[var(--muted)] line-clamp-1">{d.summary_for_human}</p>
                  )}
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      {pendingReview === 0 && ratifiedCount === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-6 py-8 space-y-5">
          <div>
            <p className="text-sm font-medium mb-1">No continuity objects yet.</p>
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Govinuity starts with candidate decisions. Surface them from ongoing work, review them on the{" "}
              <Link href="/review" className="text-[var(--accent)] hover:underline">Review</Link> page, and only ratified decisions become reusable future context.
            </p>
          </div>

          {/* Seed data */}
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Load an example loop</p>
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Add a small set of proposals and ratified decisions so the review queue, decision log, and injection path are visible before connecting real session data.
            </p>
            {seedDone ? (
              <p className="text-xs text-[var(--brand-green)]">Example data loaded — check <Link href="/review" className="underline hover:opacity-80">Review</Link> and <Link href="/decisions" className="underline hover:opacity-80">Decisions</Link>.</p>
            ) : (
              <button
                onClick={seedData}
                disabled={seeding}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)] hover:bg-[var(--panel-2)] disabled:opacity-40 transition-colors"
              >
                {seeding ? "Loading…" : "Load example data"}
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Submit a candidate directly</p>
            <pre className="rounded bg-[var(--panel-2)] border border-[var(--border)] p-3 text-xs leading-relaxed overflow-x-auto text-[var(--foreground)]">{`curl -X POST http://localhost:3000/api/decisions \\
  -H "Content-Type: application/json" \\
  -d '{
    "body": "All database migrations must be reviewed before running in production.",
    "status": "proposed",
    "proposal_class": "durable_constraint",
    "summary_for_human": "Prevents unreviewed migrations from reaching production.",
    "rationale": "A bad migration is hard to reverse and can cause data loss."
  }'`}</pre>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Surface from session files</p>
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              The <Link href="/harvest" className="text-[var(--accent)] hover:underline">Harvest</Link> page scans agent session files and routes candidate decisions into review.
            </p>
          </div>
        </div>
      )}

      {/* Surfacing pointer — visible when the app has data but no runs yet */}
      {(pendingReview > 0 || ratifiedCount > 0) && metrics?.runs.last_30d === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-4 space-y-2">
          <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Keep surfacing proposals</p>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Use the <Link href="/harvest" className="text-[var(--accent)] hover:underline">Harvest</Link> page to scan agent session files and keep candidate decisions moving into review.
            Injection sessions will appear on <Link href="/runs" className="text-[var(--accent)] hover:underline">Runs</Link> once you call{" "}
            <code className="font-mono bg-[var(--panel-2)] px-1 rounded">GET /api/memory</code> or generate a <code className="font-mono bg-[var(--panel-2)] px-1 rounded">GOVERNED_CONTINUITY.md</code> from{" "}
            <Link href="/decisions" className="text-[var(--accent)] hover:underline">Decisions</Link>.
          </p>
        </div>
      )}
    </div>
  );
}
