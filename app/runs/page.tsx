"use client";

import { useEffect, useState } from "react";
import { PageHeader, ProjectBar } from "../components/ui";
import { timeAgo } from "../../lib/utils";
import type { ContinuityRunRecord } from "../../lib/run-log";
import type { RunAnnotation, AnnotationType } from "../../lib/annotation-log";

type DecisionRef = {
  id: string;
  title?: string | null;
  body?: string | null;
  status?: string | null;
};

const ANNOTATION_CONFIG: {
  type: AnnotationType;
  label: string;
  tone: "amber" | "red" | "green";
}[] = [
  { type: "context_restatement_required", label: "Context restated",    tone: "amber" },
  { type: "continuity_correction_required", label: "Correction required", tone: "amber" },
  { type: "stale_leakage_detected",        label: "Stale leakage",       tone: "red"   },
  { type: "approved_decision_followed",    label: "Decision followed",    tone: "green" },
  { type: "approved_decision_not_followed", label: "Decision not followed", tone: "red" },
];

const TONE_CLASS = {
  amber: {
    idle: "border-amber-800/50 text-amber-500/70 hover:border-amber-600 hover:text-amber-400",
    active: "border-amber-600 bg-amber-950/40 text-amber-300",
  },
  red: {
    idle: "border-red-800/50 text-red-500/70 hover:border-red-600 hover:text-red-400",
    active: "border-red-600 bg-red-950/40 text-red-300",
  },
  green: {
    idle: "border-green-800/50 text-green-500/70 hover:border-green-600 hover:text-green-400",
    active: "border-green-600 bg-green-950/40 text-green-300",
  },
};

function RunCard({
  run,
  annotations,
  decisionById,
  onAnnotated,
}: {
  run: ContinuityRunRecord;
  annotations: RunAnnotation[];
  decisionById: Record<string, DecisionRef>;
  onAnnotated: (runId: string, newAnnotations: RunAnnotation[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAnnotate, setShowAnnotate] = useState(false);
  const [selected, setSelected] = useState<Set<AnnotationType>>(new Set());
  const [targetDecisionId, setTargetDecisionId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const injectedDecisions = run.injected_ids
    .map((id) => decisionById[id] ?? { id, title: id })
    .filter(Boolean);
  const existingTypes = new Set(
    annotations
      .filter((a) => (a.decision_id ?? "") === targetDecisionId)
      .map((a) => a.annotation_type),
  );

  function decisionLabel(id?: string | null) {
    if (!id) return "whole run";
    const decision = decisionById[id];
    return decision?.title ?? decision?.body?.slice(0, 72) ?? id;
  }

  function toggle(type: AnnotationType) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0) return;
    setSaving(true);
    const created: RunAnnotation[] = [];
    for (const annotation_type of selected) {
      const res = await fetch("/api/run-annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: run.run_id,
          annotation_type,
          value: true,
          decision_id: targetDecisionId || null,
          note: note.trim() || null,
        }),
      });
      if (res.ok) {
        const { annotation } = await res.json();
        created.push(annotation);
      }
    }
    setSaving(false);
    setSelected(new Set());
    setNote("");
    onAnnotated(run.run_id, created);
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-4 py-3"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-[var(--muted)] font-mono">{run.run_id.slice(0, 18)}…</span>
          {run.project && (
            <span className="text-xs rounded border border-[var(--border)] px-1.5 py-0.5 text-[var(--muted)]">
              {run.project}
            </span>
          )}
          {run.source && (
            <span className="text-xs text-[var(--muted)]">{run.source}</span>
          )}
          <span className="ml-auto text-xs text-[var(--muted)]">{timeAgo(run.ts)}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-4 text-xs">
          <span className="text-indigo-400">{run.injected_count} injected</span>
          {run.excluded_count > 0 && (
            <span className="text-[var(--muted)]">{run.excluded_count} excluded</span>
          )}
          {annotations.length > 0 && (
            <span className="text-amber-400">{annotations.length} annotation{annotations.length > 1 ? "s" : ""}</span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] px-4 py-3 space-y-4">
          {/* Existing annotations */}
          {annotations.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {annotations.map((a) => {
                const cfg = ANNOTATION_CONFIG.find((c) => c.type === a.annotation_type);
                return (
                  <span
                    key={a.annotation_id}
                    className={`rounded border px-2 py-0.5 text-xs ${TONE_CLASS[cfg?.tone ?? "amber"].active}`}
                  >
                    {cfg?.label ?? a.annotation_type}
                    {a.decision_id && (
                      <span className="ml-1 opacity-70">· {decisionLabel(a.decision_id)}</span>
                    )}
                  </span>
                );
              })}
            </div>
          )}

          {/* Excluded reasons */}
          {run.excluded.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wider text-[var(--muted)]">Excluded</p>
              {run.excluded.map((e) => (
                <div key={e.id} className="flex items-center justify-between text-xs">
                  <span className="text-[var(--foreground)] truncate max-w-[60%]">{e.title || e.id}</span>
                  <span className="text-[var(--muted)] font-mono ml-2">{e.reason}</span>
                </div>
              ))}
            </div>
          )}

          {/* Annotation form — collapsed by default */}
          <div>
            <button
              onClick={() => setShowAnnotate(v => !v)}
              className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
            >
              {showAnnotate ? "▾ Hide manual annotation" : "▸ Annotate manually"}
            </button>
            {showAnnotate && (
              <div className="mt-2.5 space-y-2.5">
                <div>
                  <label className="mb-1 block text-xs text-[var(--muted)]">Applies to</label>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { id: "", label: "Whole run" },
                      ...injectedDecisions.map((decision) => ({
                        id: decision.id,
                        label: decisionLabel(decision.id),
                      })),
                    ].map((target) => {
                      const active = targetDecisionId === target.id;
                      return (
                        <button
                          key={target.id || "whole-run"}
                          onClick={() => { setTargetDecisionId(target.id); setSelected(new Set()); }}
                          className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                            active
                              ? "border-indigo-700 bg-indigo-950/60 text-indigo-300"
                              : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                          }`}
                        >
                          {target.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ANNOTATION_CONFIG.map(({ type, label, tone }) => {
                    const alreadyDone = existingTypes.has(type);
                    const isSelected = selected.has(type);
                    return (
                      <button
                        key={type}
                        onClick={() => !alreadyDone && toggle(type)}
                        disabled={alreadyDone}
                        className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                          alreadyDone
                            ? `${TONE_CLASS[tone].active} opacity-50 cursor-default`
                            : isSelected
                              ? TONE_CLASS[tone].active
                              : TONE_CLASS[tone].idle
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {selected.size > 0 && (
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder="Optional note…"
                    className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-indigo-700 resize-none"
                  />
                )}
                <button
                  onClick={submit}
                  disabled={saving || selected.size === 0}
                  className="rounded bg-indigo-700 px-3 py-1.5 text-xs text-white hover:bg-indigo-600 disabled:opacity-40"
                >
                  {saving ? "Saving…" : `Save${selected.size > 0 ? ` (${selected.size})` : ""}`}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


function RecordSessionPanel({ activeProject, onLogged }: { activeProject: string | null; onLogged: () => void }) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<"file" | "manual">("file");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ injected_count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setResult(null);
    setError(null);
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: activeProject ?? undefined, source, note: note.trim() || undefined }),
    });
    const data = await res.json();
    setSaving(false);
    if (res.ok) {
      setResult(data);
      setNote("");
      onLogged();
    } else {
      setError(data.error ?? "Unknown error");
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <button
        onClick={() => { setOpen((v) => !v); setResult(null); setError(null); }}
        className="w-full text-left px-4 py-3 flex items-center gap-2"
      >
        <span className="text-sm font-medium">Record a past session</span>
        <span className="text-xs text-[var(--muted)]">— add a run record for a session that wasn't captured automatically</span>
        <span className="ml-auto text-xs text-[var(--muted)]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--border)] px-4 py-3 space-y-3">
          <p className="text-xs text-[var(--muted)]">
            Creates a run record using the currently active decisions{activeProject ? ` for project "${activeProject}"` : ""}.
            Use this when you completed a session with <code className="font-mono bg-[var(--panel-2)] px-1 rounded">GOVERNED_CONTINUITY.md</code> active
            but the run wasn't captured automatically — for example, before run-logging was set up.
            This does not extract decisions; it only records what was active at the time.
          </p>
          <div className="flex gap-3 text-xs">
            {(["file", "manual"] as const).map((s) => (
              <label key={s} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="source"
                  value={s}
                  checked={source === s}
                  onChange={() => setSource(s)}
                  className="accent-indigo-500"
                />
                <span className="text-[var(--foreground)]">{s === "file" ? "File injection (GOVERNED_CONTINUITY.md)" : "Manual / other"}</span>
              </label>
            ))}
          </div>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (e.g. 'auth refactor session')"
            className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-indigo-700"
          />
          <button
            onClick={submit}
            disabled={saving}
            className="rounded bg-indigo-700 px-3 py-1.5 text-xs text-white hover:bg-indigo-600 disabled:opacity-40"
          >
            {saving ? "Logging…" : "Log session"}
          </button>
          {result && (
            <p className="text-xs text-green-400">
              Session logged · {result.injected_count} decision{result.injected_count !== 1 ? "s" : ""} recorded
            </p>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}

export default function RunsPage() {
  const [runs, setRuns] = useState<ContinuityRunRecord[]>([]);
  const [annotations, setAnnotations] = useState<Record<string, RunAnnotation[]>>({});
  const [decisionById, setDecisionById] = useState<Record<string, DecisionRef>>({});
  const [stats, setStats] = useState<{ total_runs: number; total_injected: number; total_excluded: number; exclusion_reasons: Record<string, number> } | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeProject, setActiveProject] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const proj = activeProject ? `&project=${activeProject}` : "";
    const [runsData, annotsData, decisionsData] = await Promise.all([
      fetch(`/api/runs?limit=50${proj}`).then((r) => r.json()),
      fetch(`/api/run-annotations?limit=500`).then((r) => r.json()),
      fetch("/api/decisions?limit=500").then((r) => r.json()),
    ]);

    const fetchedRuns: ContinuityRunRecord[] = runsData.runs ?? [];
    setRuns(fetchedRuns);
    setStats(runsData.stats ?? null);

    // Group annotations by run_id
    const grouped: Record<string, RunAnnotation[]> = {};
    for (const a of (annotsData.annotations ?? []) as RunAnnotation[]) {
      if (!grouped[a.run_id]) grouped[a.run_id] = [];
      grouped[a.run_id].push(a);
    }
    setAnnotations(grouped);
    const decisions: DecisionRef[] = decisionsData.entries ?? [];
    setDecisionById(Object.fromEntries(decisions.map((d) => [d.id, d])));
    setLoading(false);
  }

  useEffect(() => { load(); }, [activeProject]);

  function handleAnnotated(runId: string, newAnnotations: RunAnnotation[]) {
    setAnnotations((prev) => ({
      ...prev,
      [runId]: [...(prev[runId] ?? []), ...newAnnotations],
    }));
  }

  const annotatedRunCount = Object.values(annotations).filter((a) => a.length > 0).length;

  if (loading) return <div className="text-[var(--muted)] text-sm">Loading…</div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Runs"
        description={`${stats?.total_runs ?? 0} continuity runs logged · ${annotatedRunCount} annotated — annotate runs to make continuity outcomes measurable.`}
      />

      <ProjectBar activeProject={activeProject} onSelect={setActiveProject} />

      <RecordSessionPanel activeProject={activeProject} onLogged={load} />

      {/* Stats strip */}
      {stats && stats.total_runs > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
            <p className="text-xs text-[var(--muted)]">Total injections</p>
            <p className="text-lg font-semibold">{stats.total_injected}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
            <p className="text-xs text-[var(--muted)]">Total exclusions</p>
            <p className="text-lg font-semibold">{stats.total_excluded}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
            <p className="text-xs text-[var(--muted)]">Annotated</p>
            <p className="text-lg font-semibold">{annotatedRunCount}</p>
          </div>
        </div>
      )}

      {/* Exclusion reason breakdown */}
      {stats && Object.keys(stats.exclusion_reasons).length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <p className="text-xs uppercase tracking-wider text-[var(--muted)] mb-2">Exclusion reasons</p>
          <div className="flex flex-wrap gap-3">
            {Object.entries(stats.exclusion_reasons).map(([reason, count]) => (
              <div key={reason} className="text-xs">
                <span className="font-mono text-[var(--muted)]">{reason}</span>
                <span className="ml-1.5 font-semibold">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run list */}
      {runs.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-[var(--muted)]">No runs logged yet.</p>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Runs are created automatically when an agent calls <code className="font-mono bg-[var(--panel-2)] px-1 rounded">GET /api/memory</code> to pull active decisions into context,
            or when you generate a <code className="font-mono bg-[var(--panel-2)] px-1 rounded">GOVERNED_CONTINUITY.md</code> file from the Decisions page.
            You can also log a past session manually using the panel above.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <RunCard
              key={run.run_id}
              run={run}
              annotations={annotations[run.run_id] ?? []}
              decisionById={decisionById}
              onAnnotated={handleAnnotated}
            />
          ))}
        </div>
      )}
    </div>
  );
}
