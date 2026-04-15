"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4 border-b border-[var(--border)] pb-4">
      <div>
        <div className="mb-2 h-1 w-12 rounded-full bg-[var(--brand-gold)]" />
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{description}</p>}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}

export function StatusBadge({
  text,
  tone = "neutral",
}: {
  text: string;
  tone?: "neutral" | "info" | "success" | "warning" | "danger" | "accent" | "reflection";
}) {
  const tones: Record<string, string> = {
    neutral: "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)]",
    info: "border-[var(--brand-gold)] bg-[var(--brand-gold-soft)] text-[var(--brand-gold)]",
    success: "border-[var(--brand-green)] bg-[var(--brand-green-soft)] text-[var(--brand-green)]",
    warning: "border-[var(--brand-gold)] bg-[var(--brand-gold-soft)] text-[var(--brand-gold)]",
    danger: "border-[var(--brand-coral)] bg-[var(--brand-coral-soft)] text-[var(--brand-coral)]",
    accent: "border-[var(--brand-coral)] bg-[var(--brand-coral-soft)] text-[var(--brand-coral)]",
    reflection: "border-[var(--brand-gold)] bg-[var(--brand-gold-soft)] text-[var(--brand-gold)]",
  };

  return <span className={cx("inline-flex rounded border px-1.5 py-0.5 font-mono text-xs", tones[tone])}>{text}</span>;
}

export function MetricTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "accent" | "warning" | "success";
}) {
  const map = {
    neutral: "border-[var(--border)]",
    accent: "border-[var(--brand-coral)]",
    warning: "border-[var(--brand-gold)]",
    success: "border-[var(--brand-green)]",
  };
  const bars = {
    neutral: "bg-[var(--border)]",
    accent: "bg-[var(--brand-coral)]",
    warning: "bg-[var(--brand-gold)]",
    success: "bg-[var(--brand-green)]",
  };
  return (
    <div className={cx("rounded-lg border bg-[var(--surface)] p-3", map[tone])}>
      <div className={cx("mb-3 h-1 w-8 rounded-full", bars[tone])} />
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

export function SectionCard({
  title,
  action,
  children,
  tone = "neutral",
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  tone?: "neutral" | "action" | "artifact";
}) {
  const toneClass =
    tone === "action"
      ? "border-[var(--brand-gold)]"
      : tone === "artifact"
        ? "border-[var(--brand-green)]"
        : "border-[var(--border)]";

  return (
    <section className={cx("rounded-lg border bg-[var(--surface)] p-5", toneClass)}>
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function StackedBar({
  segments,
}: {
  segments: Array<{ label: string; value: number; tone: "neutral" | "info" | "success" | "warning" | "danger" | "accent" | "reflection" }>;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const tones: Record<string, string> = {
    neutral: "bg-[var(--border)]",
    info: "bg-[var(--brand-gold)]",
    success: "bg-[var(--brand-green)]",
    warning: "bg-[var(--brand-gold)]",
    danger: "bg-[var(--brand-coral)]",
    accent: "bg-[var(--brand-coral)]",
    reflection: "bg-[var(--brand-gold)]",
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-2 text-[11px] text-[var(--muted)]">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center gap-1.5">
            <span className={cx("h-2.5 w-2.5 rounded-full", tones[segment.tone])} />
            <span>{segment.label}: {segment.value}</span>
          </div>
        ))}
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full border border-[var(--border)] bg-[var(--panel-2)]">
        {segments.map((segment) => {
          const width = total > 0 ? `${(segment.value / total) * 100}%` : "0%";
          return <div key={segment.label} className={tones[segment.tone]} style={{ width }} title={`${segment.label}: ${segment.value}`} />;
        })}
      </div>
    </div>
  );
}

export type ProjectSummary = {
  project: {
    slug: string;
    name: string;
    color: string;
    context_keys?: string[];
    status?: string;
  };
  counts: {
    pendingReview: number;
    openFollowUps?: number;
  };
  lastActivityTs?: string | null;
};

// Alias kept for SidebarNav internal use
type WorkspaceSummary = ProjectSummary;

/** Client-side: match a context string to a project slug using context_keys or slug prefix. */
export function resolveProjectSlug(context: string | null | undefined, projects: ProjectSummary[]): string | null {
  if (!context) return null;
  return (
    projects.find((p) => {
      const keys = p.project.context_keys ?? [p.project.slug];
      return keys.some((key) => context === key || context.startsWith(`${key}:`));
    })?.project.slug ?? null
  );
}

export function ProjectBar({
  activeProject,
  onSelect,
  onLoaded,
}: {
  activeProject: string | null;
  onSelect: (slug: string | null) => void;
  onLoaded?: (projects: ProjectSummary[]) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => {
        const list: ProjectSummary[] = data.projects ?? [];
        setProjects(list);
        onLoaded?.(list);
      })
      .catch(() => {});
  }, []);

  if (projects.length === 0) return null;

  return (
    <div className="mb-5 flex flex-wrap gap-1.5">
      <button
        onClick={() => onSelect(null)}
        className={cx(
          "rounded-full border px-3 py-1 text-xs transition-colors",
          activeProject === null
            ? "border-[var(--brand-gold)] bg-[var(--surface)] text-[var(--foreground)]"
            : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
        )}
      >
        All projects
      </button>
      {projects.map((entry) => {
        const open = (entry.counts.pendingReview ?? 0) + (entry.counts.openFollowUps ?? 0);
        const isActive = activeProject === entry.project.slug;
        return (
          <button
            key={entry.project.slug}
            onClick={() => onSelect(isActive ? null : entry.project.slug)}
            className={cx(
              "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
              isActive
                ? "border-[var(--brand-gold)] bg-[var(--surface)] text-[var(--foreground)]"
                : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]",
            )}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: entry.project.color }} />
            {entry.project.name}
            {open > 0 && (
              <span className="rounded bg-[var(--border)] px-1 text-[10px]">{open}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const QUICK_LOG_TYPES = [
  { value: "observation", label: "Observation" },
  { value: "proposal", label: "Proposal" },
  { value: "interpretation", label: "Interpretation" },
  { value: "question", label: "Question" },
] as const;

const QUICK_DECISION_TYPES = [
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "deferred", label: "Deferred" },
] as const;

export function QuickLog({ projects }: { projects: ProjectSummary[] }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"feedback" | "decision">("feedback");
  const [body, setBody] = useState("");
  const [type, setType] = useState("observation");
  const [decision, setDecision] = useState("approved");
  const [project, setProject] = useState<string>("");
  const [context, setContext] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  function onProjectChange(slug: string) {
    setProject(slug);
    const proj = projects.find((p) => p.project.slug === slug);
    const keys = proj?.project.context_keys;
    if (keys && keys[0]) setContext(keys[0]);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (!typing && e.key === "n" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || !context.trim()) return;
    setSaving(true);
    try {
      const endpoint = mode === "feedback" ? "/api/feedback" : "/api/decisions";
      const payload =
        mode === "feedback"
          ? { body, type, context, project: project || undefined }
          : { proposal: body, decision, context, project: project || undefined };
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setFlash("Saved ✓");
      setBody("");
      setTimeout(() => { setFlash(null); setOpen(false); }, 900);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Quick log (n)"
        className="flex w-full items-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-left text-sm text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        <span className="text-base leading-none">+</span>
        <span>Quick log</span>
        <span className="ml-auto text-[10px] opacity-50">n</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-start" onClick={() => setOpen(false)}>
          <div
            className="relative mb-0 ml-0 w-80 rounded-t-xl border border-[var(--border)] bg-[var(--sidebar)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex gap-1">
                {(["feedback", "decision"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={cx(
                      "rounded px-2.5 py-1 text-xs transition-colors",
                      mode === m ? "bg-[var(--surface)] text-[var(--foreground)]" : "text-[var(--muted)] hover:text-[var(--foreground)]",
                    )}
                  >
                    {m === "feedback" ? "Feedback" : "Decision"}
                  </button>
                ))}
              </div>
              <button onClick={() => setOpen(false)} className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]">✕</button>
            </div>

            <form onSubmit={submit} className="space-y-2.5">
              <textarea
                autoFocus
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={mode === "feedback" ? "What do you want to log?" : "What is the decision?"}
                rows={3}
                className="w-full resize-none rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder-[var(--muted)] focus:border-[var(--accent)] focus:outline-none"
              />

              <div className="grid grid-cols-2 gap-2">
                {mode === "feedback" ? (
                  <select value={type} onChange={(e) => setType(e.target.value)} className="rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none">
                    {QUICK_LOG_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                ) : (
                  <select value={decision} onChange={(e) => setDecision(e.target.value)} className="rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none">
                    {QUICK_DECISION_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                )}
                <select value={project} onChange={(e) => onProjectChange(e.target.value)} className="rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none">
                  <option value="">Project…</option>
                  {projects.map((p) => (
                    <option key={p.project.slug} value={p.project.slug}>{p.project.name}</option>
                  ))}
                </select>
              </div>

              <input
                value={context}
                onChange={(e) => setContext(e.target.value)}
                placeholder="Context (e.g. my-project:feature)"
                className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-xs font-mono text-[var(--foreground)] placeholder-[var(--muted)] focus:border-[var(--accent)] focus:outline-none"
              />

              <button
                type="submit"
                disabled={saving || !body.trim() || !context.trim()}
                className="w-full rounded border border-[var(--accent)] py-1.5 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--brand-gold-soft)] disabled:opacity-40"
              >
                {flash ?? (saving ? "…" : "Save")}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export function SidebarNav() {
  const pathname = usePathname();
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch("/api/sidebar")
      .then((r) => r.json())
      .then((data) => { setCounts(data.counts ?? {}); })
      .catch(() => {});
  }, []);

  const proposalsCount = counts["proposals"] ?? 0;
  const decisionsCount = counts["decisions_total"] ?? 0;

  const navItems = [
    { href: "/",          label: "Dashboard", hint: "home",    count: 0 },
    { href: "/harvest",   label: "Harvest",   hint: "surface", count: 0 },
    { href: "/review",    label: "Review",    hint: "review",  count: proposalsCount, urgentCount: true },
    { href: "/decisions", label: "Decisions", hint: "inject",  count: decisionsCount },
    { href: "/runs",      label: "Runs",      hint: "measure", count: counts["runs"] ?? 0 },
  ];

  return (
    <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--sidebar)]">
      <div className="border-b border-[var(--border)] px-5 py-6">
        <div className="mb-3 flex items-center gap-2.5">
          <Image
            src="/brand/mark.svg"
            alt=""
            aria-hidden="true"
            width={28}
            height={28}
            className="shrink-0 rounded"
            priority
          />
          <p className="text-sm font-semibold tracking-wide text-[var(--foreground)]">Govinuity</p>
        </div>
        <p className="text-xs leading-relaxed text-[var(--muted)]">Governed continuity for human-agent work.</p>
      </div>

      <nav className="flex-1 px-3 py-4">
        <div className="space-y-1">
          {navItems.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cx(
                  "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors",
                  active
                    ? "border-[var(--brand-gold)] bg-[var(--surface)] text-[var(--foreground)]"
                    : "border-transparent text-[var(--muted)] hover:border-[var(--border)] hover:bg-[var(--panel-2)] hover:text-[var(--foreground)]",
                )}
              >
                <span className="text-sm font-medium">{item.label}</span>
                <div className="flex items-center gap-2">
                  {item.count > 0 && (
                    <StatusBadge
                      text={String(item.count)}
                      tone={active ? "accent" : item.urgentCount ? "warning" : "neutral"}
                    />
                  )}
                  <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">{item.hint}</span>
                </div>
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="px-4 py-3 border-t border-[var(--border)]">
        <p className="text-[10px] leading-relaxed text-[var(--muted)] opacity-60">
          Trusted local use only · no authentication
        </p>
      </div>
    </aside>
  );
}
