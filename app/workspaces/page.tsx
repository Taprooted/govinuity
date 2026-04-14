"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, SectionCard, StatusBadge } from "../components/ui";
import { timeAgo } from "../../lib/utils";

const COLORS = [
  { label: "Blue", value: "#6B7FD4" },
  { label: "Amber", value: "#D4A56B" },
  { label: "Green", value: "#5FAE8B" },
  { label: "Rose", value: "#D46B8A" },
  { label: "Lilac", value: "#9B6BD4" },
  { label: "Cyan", value: "#6BB8D4" },
];

function NewProjectForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [contextKeys, setContextKeys] = useState("");
  const [color, setColor] = useState(COLORS[0].value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function deriveSlug(val: string) {
    return val.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          name,
          description,
          color,
          context_keys: contextKeys.split(",").map((k) => k.trim()).filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Creation failed");
      setOpen(false);
      setSlug(""); setName(""); setDescription(""); setContextKeys(""); setColor(COLORS[0].value);
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded border border-dashed border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        New project
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 space-y-4">
      <p className="text-sm font-medium">New project</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-[var(--muted)]">Name</label>
          <input
            required
            value={name}
            onChange={(e) => { setName(e.target.value); if (!slug) setSlug(deriveSlug(e.target.value)); }}
            placeholder="My project"
            className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-[var(--muted)]">Slug (URL-id)</label>
          <input
            required
            value={slug}
            onChange={(e) => setSlug(deriveSlug(e.target.value))}
            placeholder="my-project"
            pattern="[a-z0-9-]+"
            className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-sm font-mono outline-none focus:border-[var(--accent)]"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs text-[var(--muted)]">Description</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description of this project"
          className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs text-[var(--muted)]">Context keys (comma-separated)</label>
        <input
          value={contextKeys}
          onChange={(e) => setContextKeys(e.target.value)}
          placeholder={slug || "project-slug, project-slug:sub"}
          className="w-full rounded border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-sm font-mono outline-none focus:border-[var(--accent)]"
        />
        <p className="mt-1 text-xs text-[var(--muted)]">Empty = only the slug itself</p>
      </div>

      <div>
        <label className="mb-1 block text-xs text-[var(--muted)]">Color</label>
        <div className="flex gap-2 flex-wrap">
          {COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setColor(c.value)}
              title={c.label}
              className="h-6 w-6 rounded-full transition-transform hover:scale-110"
              style={{ backgroundColor: c.value, outline: color === c.value ? `2px solid ${c.value}` : undefined, outlineOffset: "2px" }}
            />
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded border border-[var(--accent)] px-3 py-1.5 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--accent)] hover:text-black disabled:opacity-40"
        >
          {saving ? "Creating…" : "Create project"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] transition-colors hover:bg-[var(--panel-2)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

type ProjectAggregate = {
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
  };
  lastActivityTs: string | null;
  samples: {
    recentDecisions: Array<{ id: string; decision: string; proposal: string; ts: string }>;
  };
};

function densityLabel(total: number) {
  if (total >= 20) return "high";
  if (total >= 8) return "medium";
  return "low";
}

export default function WorkspacesPage() {
  const [projects, setProjects] = useState<ProjectAggregate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function loadProjects() {
    setLoading(true);
    fetch("/api/projects")
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load workspaces");
        return r.json();
      })
      .then((data) => {
        setProjects(data.projects ?? []);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err.message || err));
        setLoading(false);
      });
  }

  useEffect(() => { loadProjects(); }, []);

  return (
    <div>
      <PageHeader
        title="Workspaces"
        description="Overview of all projects."
      />

      <div className="mb-4">
        <NewProjectForm onCreated={loadProjects} />
      </div>

      <SectionCard title="Projects" tone="artifact">
        {loading ? (
          <p className="text-sm text-[var(--muted)]">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-300">{error}</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No workspaces found.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {projects.map((entry) => {
              const totalActivity = entry.counts.feedback + entry.counts.decisions + entry.counts.review;
              const density = densityLabel(totalActivity);
              return (
                <Link
                  key={entry.project.slug}
                  href={`/workspaces/${entry.project.slug}`}
                  className="block rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:bg-[var(--panel-2)]"
                >
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: entry.project.color }} />
                      <div>
                        <p className="text-sm font-medium">{entry.project.name}</p>
                        <p className="text-xs text-[var(--muted)]">{entry.project.description}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 flex-wrap justify-end">
                      <StatusBadge text={entry.project.status ?? "active"} tone="success" />
                      <StatusBadge text={`density ${density}`} tone={totalActivity >= 20 ? "success" : totalActivity >= 8 ? "info" : "warning"} />
                    </div>
                  </div>

                  <div className="mb-3 grid grid-cols-3 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-[var(--muted)]">Open review</p>
                      <p className="mt-0.5 font-medium">{entry.counts.pendingReview}</p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--muted)]">Decisions</p>
                      <p className="mt-0.5 font-medium">{entry.counts.decisions}</p>
                    </div>
                  </div>

                  <div className="mb-3">
                    <p className="mb-1 text-xs text-[var(--muted)]">Last activity</p>
                    <p className="text-sm">{timeAgo(entry.lastActivityTs)}</p>
                  </div>

                  <div>
                    <p className="mb-1 text-xs text-[var(--muted)]">Recent decisions</p>
                    {entry.samples.recentDecisions.length === 0 ? (
                      <p className="text-sm text-[var(--muted)]">No recent decisions.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {entry.samples.recentDecisions.slice(0, 3).map((decision) => (
                          <div key={decision.id} className="rounded border border-[var(--border)] px-2 py-1.5 text-sm">
                            {decision.proposal}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
