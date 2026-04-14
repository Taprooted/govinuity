"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "../components/ui";
import { timeAgo } from "../../lib/utils";

type HarvestMeta = {
  running: boolean;
  started_at?: string;
  running_hours?: number;
  last_run_ts?: string;
  last_run_hours?: number;
  last_submitted?: number;
  last_annotations?: number;
  last_duration_ms?: number;
  last_output_tail?: string[];
};

type Mode = "sessions" | "text";

const LOOKBACK_OPTIONS = [
  { label: "4 h",  hours: 4   },
  { label: "24 h", hours: 24  },
  { label: "48 h", hours: 48  },
  { label: "7 d",  hours: 168 },
];

const SOURCE_LABELS = [
  { value: "claude-code",          label: "Claude Code" },
  { value: "cursor",               label: "Cursor" },
  { value: "openai-assistants",    label: "OpenAI Assistants" },
  { value: "langgraph",            label: "LangGraph" },
  { value: "custom",               label: "Other" },
];

export default function HarvestPage() {
  const [meta, setMeta] = useState<HarvestMeta | null>(null);
  const [mode, setMode] = useState<Mode>("sessions");

  // Sessions mode state
  const [hours, setHours] = useState(48);
  const [customHours, setCustomHours] = useState("");
  const [sessionDir, setSessionDir] = useState("");
  const [configuredSessionDir, setConfiguredSessionDir] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoInterval, setAutoInterval] = useState<number | null>(null);
  const [nextRunIn, setNextRunIn] = useState<string | null>(null);

  // Text mode state
  const [pastedText, setPastedText] = useState("");
  const [sourceLabel, setSourceLabel] = useState("claude-code");
  const [customSource, setCustomSource] = useState("");

  // Shared state
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ submitted: number; annotations: number; output: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchMeta() {
    const d = await fetch("/api/harvest").then((r) => r.json());
    const m: HarvestMeta = d.meta ?? { running: false };
    setMeta(m);
    return m;
  }

  useEffect(() => {
    fetch("/api/harvest").then((r) => r.json()).then((d) => {
      const m: HarvestMeta = d.meta ?? { running: false };
      setMeta(m);
      if (m.running) setRunning(true);
      if (d.sessionDir) setConfiguredSessionDir(d.sessionDir);
    });
  }, []);

  // Poll while running — sessions mode only (text mode is synchronous)
  useEffect(() => {
    if (!running || mode === "text") return;
    const poll = setInterval(async () => {
      const m = await fetchMeta();
      if (!m.running) {
        setRunning(false);
        clearInterval(poll);
        if (m.last_output_tail) {
          setResult({ submitted: m.last_submitted ?? 0, annotations: m.last_annotations ?? 0, output: m.last_output_tail });
        }
      }
    }, 3_000);
    return () => clearInterval(poll);
  }, [running, mode]);

  // Auto-harvest ticker (sessions mode, browser-based)
  useEffect(() => {
    if (autoInterval === null) { setNextRunIn(null); return; }
    const intervalMs = autoInterval * 60 * 60 * 1000;
    let remaining = intervalMs;
    const tick = setInterval(() => {
      remaining -= 10_000;
      if (remaining <= 0) { remaining = intervalMs; runHarvest(); }
      const h = Math.floor(remaining / 3_600_000);
      const m = Math.floor((remaining % 3_600_000) / 60_000);
      setNextRunIn(`${h}h ${m}m`);
    }, 10_000);
    setNextRunIn(`${autoInterval}h 0m`);
    return () => clearInterval(tick);
  }, [autoInterval]);

  async function runHarvest() {
    setRunning(true);
    setResult(null);
    setError(null);

    const effectiveHours = customHours.trim() ? parseInt(customHours, 10) : hours;
    const effectiveSource = sourceLabel === "custom" ? customSource.trim() || "custom" : sourceLabel;

    const payload =
      mode === "text"
        ? { mode: "text", text: pastedText, source: effectiveSource }
        : { mode: "sessions", hours: effectiveHours, sessionDir: sessionDir.trim() || undefined };

    const res = await fetch("/api/harvest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (mode === "text") setRunning(false);

    if (res.ok && data.ok) {
      setResult({ submitted: data.submitted, annotations: data.annotations, output: data.output ?? [] });
      if (mode === "sessions") await fetchMeta();
    } else {
      setRunning(false);
      setError(data.error ?? "Harvest failed");
    }
  }

  const effectiveHours = customHours.trim() ? parseInt(customHours, 10) : hours;
  const canSubmit = mode === "sessions" ? !running : pastedText.trim().length > 0 && !running;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Harvest"
        description="Surface candidate decisions from your agent sessions. Extracted proposals go to Review — nothing becomes active context until you ratify it."
      />

      {/* Main harvest card */}
      <div className="rounded-lg border border-indigo-800/40 bg-[var(--surface)] px-5 py-4 space-y-4">

        {/* Mode tabs */}
        <div className="flex items-center gap-1">
          {([
            { id: "sessions" as Mode, label: "Scan session files" },
            { id: "text"     as Mode, label: "Paste session text" },
          ] as const).map((m) => (
            <button
              key={m.id}
              onClick={() => { setMode(m.id); setResult(null); setError(null); }}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === m.id
                  ? "bg-indigo-900/60 text-indigo-200"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {m.label}
            </button>
          ))}
          {meta?.last_run_ts && !running && (
            <span className="ml-auto text-xs text-[var(--muted)]">
              Last run {timeAgo(meta.last_run_ts)} · {meta.last_submitted ?? 0} submitted · {meta.last_annotations ?? 0} annotations
            </span>
          )}
          {running && <span className="ml-auto text-xs text-indigo-400 animate-pulse">Harvesting…</span>}
        </div>

        {/* Sessions mode */}
        {mode === "sessions" && (
          <div className="space-y-3">
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Scans JSONL session files in a directory, extracts candidate decisions, and submits them as proposals.
              Also detects correction signals — decisions followed, ignored, or requiring restatement — and posts them as run annotations.
            </p>
            <div>
              <button
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
              >
                {showAdvanced ? "▾" : "▸"} Advanced
                {configuredSessionDir && !showAdvanced && (
                  <span className="ml-2 font-mono opacity-60">{sessionDir.trim() || configuredSessionDir}</span>
                )}
              </button>
              {showAdvanced && (
                <div className="mt-2 space-y-1">
                  <p className="text-xs text-[var(--muted)]">Session directory</p>
                  <input
                    type="text"
                    value={sessionDir}
                    onChange={(e) => setSessionDir(e.target.value)}
                    placeholder={configuredSessionDir ?? "~/.claude/projects"}
                    className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1.5 text-xs text-[var(--foreground)] placeholder:text-[var(--muted)] font-mono focus:outline-none focus:ring-1 focus:ring-indigo-700"
                  />
                  <p className="text-xs text-[var(--muted)]">
                    Override for this run only, or set <code className="font-mono bg-[var(--panel-2)] px-1 rounded">GOVINUITY_SESSION_DIR</code> in <code className="font-mono bg-[var(--panel-2)] px-1 rounded">.env.local</code> to change the default permanently.
                  </p>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-[var(--muted)]">Lookback</span>
              {LOOKBACK_OPTIONS.map((opt) => (
                <button
                  key={opt.hours}
                  onClick={() => { setHours(opt.hours); setCustomHours(""); }}
                  className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                    hours === opt.hours && !customHours.trim()
                      ? "border-indigo-600 bg-indigo-950/40 text-indigo-300"
                      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <input
                type="number"
                value={customHours}
                onChange={(e) => setCustomHours(e.target.value)}
                placeholder="custom h"
                className="w-20 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-indigo-700"
              />
              <button
                onClick={runHarvest}
                disabled={!canSubmit}
                className="rounded bg-indigo-700 px-3 py-1.5 text-xs text-white hover:bg-indigo-600 disabled:opacity-40"
              >
                {running ? "Harvesting…" : `Harvest last ${effectiveHours}h`}
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <span>Auto-harvest every</span>
              {([4, 8, 24] as const).map((h) => (
                <button
                  key={h}
                  onClick={() => setAutoInterval(autoInterval === h ? null : h)}
                  className={`rounded border px-2 py-0.5 transition-colors ${
                    autoInterval === h
                      ? "border-indigo-600 bg-indigo-950/40 text-indigo-300"
                      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {h}h
                </button>
              ))}
              {autoInterval && nextRunIn
                ? <span className="text-indigo-400">· next in {nextRunIn} (tab must stay open)</span>
                : <span>— tab must stay open</span>
              }
            </div>
          </div>
        )}

        {/* Text / paste mode */}
        {mode === "text" && (
          <div className="space-y-3">
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Paste any conversation export — labeled turns (<code className="font-mono bg-[var(--panel-2)] px-1 rounded">User: / Assistant:</code>),
              a JSON messages array, or raw text. Works with output from any agent tool.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-[var(--muted)]">Source</span>
              {SOURCE_LABELS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setSourceLabel(s.value)}
                  className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                    sourceLabel === s.value
                      ? "border-indigo-600 bg-indigo-950/40 text-indigo-300"
                      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  {s.label}
                </button>
              ))}
              {sourceLabel === "custom" && (
                <input
                  type="text"
                  value={customSource}
                  onChange={(e) => setCustomSource(e.target.value)}
                  placeholder="source name"
                  className="w-28 rounded border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-indigo-700"
                />
              )}
            </div>
            <textarea
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              rows={10}
              placeholder={"User: Let's use Postgres for this.\nAssistant: Agreed — I'll set up the schema.\n\nUser: Keep migrations reviewed before running in prod.\n..."}
              className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-xs text-[var(--foreground)] placeholder:text-[var(--muted)] font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-indigo-700 resize-y"
            />
            <button
              onClick={runHarvest}
              disabled={!canSubmit}
              className="rounded bg-indigo-700 px-3 py-1.5 text-xs text-white hover:bg-indigo-600 disabled:opacity-40"
            >
              {running ? "Extracting…" : "Extract proposals"}
            </button>
          </div>
        )}

        {/* Result / error */}
        {result && (
          <div className="space-y-1.5 pt-3 border-t border-[var(--border)]">
            <p className="text-xs text-green-400">
              Done · {result.submitted} proposal{result.submitted !== 1 ? "s" : ""} submitted to{" "}
              <Link href="/review" className="underline hover:text-green-300">Review</Link>
              {" "}· {result.annotations} annotation{result.annotations !== 1 ? "s" : ""} posted
            </p>
            {result.output.length > 0 && (
              <pre className="rounded bg-[var(--panel-2)] border border-[var(--border)] p-2 text-xs text-[var(--muted)] leading-relaxed overflow-x-auto max-h-48">{result.output.join("\n")}</pre>
            )}
          </div>
        )}
        {error && <p className="text-xs text-red-400 pt-2 border-t border-[var(--border)]">{error}</p>}
      </div>

      {/* CLI reference */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-4 space-y-2">
        <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">CLI / automation</p>
        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Run the harvest script directly for cron jobs or CI pipelines. The <code className="font-mono bg-[var(--panel-2)] px-1 rounded">--input</code> flag accepts any file or stdin.
        </p>
        <pre className="rounded bg-[var(--panel-2)] border border-[var(--border)] p-3 text-xs text-[var(--foreground)] leading-relaxed overflow-x-auto">{`# Auto-scan session files (last 48h)
python3 scripts/harvest_proposals.py --submit

# From a file export (Cursor, LangGraph, OpenAI, etc.)
python3 scripts/harvest_proposals.py --input session.txt --source cursor --submit

# From stdin
cat session.txt | python3 scripts/harvest_proposals.py --input - --source langgraph --submit`}</pre>
      </div>

      {/* Manual proposal */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-4 space-y-2">
        <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Submit a proposal directly</p>
        <pre className="rounded bg-[var(--panel-2)] border border-[var(--border)] p-3 text-xs text-[var(--foreground)] leading-relaxed overflow-x-auto">{`curl -X POST http://localhost:3000/api/decisions \\
  -H "Content-Type: application/json" \\
  -d '{
    "body": "All database migrations must be reviewed before running in production.",
    "status": "proposed",
    "proposal_class": "durable_constraint",
    "summary_for_human": "Prevents unreviewed migrations from reaching production.",
    "rationale": "A bad migration is hard to reverse and can cause data loss."
  }'`}</pre>
      </div>
    </div>
  );
}
