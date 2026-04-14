import fs from "fs";
import path from "path";
import { PATHS } from "./config";
import { readJsonlWithWarnings } from "./jsonl";
import { getDb, parseDecisionRow } from "./db";

export const PROJECTS_PATH = path.join(process.cwd(), "projects.json");
export const META_DIR = PATHS.metaDir;

export type ProjectConfig = {
  slug: string;
  name: string;
  color: string;
  description: string;
  context_keys: string[];
  agents?: string[];
  status?: string;
};

export function readJsonl(filepath: string) {
  return readJsonlWithWarnings(filepath, filepath).entries;
}

export function getProjects(): ProjectConfig[] {
  if (!fs.existsSync(PROJECTS_PATH)) return [];
  return JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf-8"));
}

export function getProjectBySlug(slug: string) {
  return getProjects().find((project) => project.slug === slug) ?? null;
}

export function contextMatchesProject(context: string | undefined, project: ProjectConfig) {
  if (!context) return false;
  return project.context_keys.some((key) => context === key || context.startsWith(`${key}:`));
}

export function inferProjectFromContext(context: string | undefined, projects = getProjects()) {
  if (!context) return null;
  return projects.find((project) => contextMatchesProject(context, project))?.slug ?? null;
}

export function resolveProjectSlug<T extends { project?: string | null; context?: string; original_entry?: { context?: string } }>(entry: T, projects = getProjects()) {
  if (entry.project) return entry.project;
  const context = entry.context ?? entry.original_entry?.context;
  return inferProjectFromContext(context, projects);
}

export function withResolvedProject<T extends { project?: string | null; context?: string; original_entry?: { context?: string } }>(entry: T, projects = getProjects()) {
  return {
    ...entry,
    project: resolveProjectSlug(entry, projects),
  };
}

export function belongsToProject<T extends { project?: string | null; context?: string; original_entry?: { context?: string } }>(entry: T, project: ProjectConfig) {
  const resolvedProject = resolveProjectSlug(entry);
  if (resolvedProject) return resolvedProject === project.slug;
  const context = entry.context ?? entry.original_entry?.context;
  return contextMatchesProject(context, project);
}

export function filterByProject<T extends { project?: string | null; context?: string; original_entry?: { context?: string } }>(entries: T[], project: ProjectConfig) {
  return entries.filter((entry) => belongsToProject(entry, project));
}

export function aggregateProject(project: ProjectConfig) {
  const db = getDb();
  const feedback = filterByProject(readJsonl(path.join(META_DIR, "feedback.jsonl")), project);
  const decisions = filterByProject(
    (db.prepare("SELECT * FROM decisions").all() as Record<string, any>[]).map(parseDecisionRow),
    project,
  );
  const review = filterByProject(
    (db.prepare("SELECT * FROM review_queue").all() as Record<string, any>[]).map((r) => ({
      ...(r as Record<string, any>),
      reviewed: r.reviewed === 1,
      original_entry: typeof r.original_entry === "string" ? JSON.parse(r.original_entry) : r.original_entry,
    } as Record<string, any>)),
    project,
  );

  const pendingReview = review.filter((item) => !item.reviewed);
  const openFollowUps = decisions.filter((entry) => (entry.follow_up_state ?? "open") === "open");

  const lastActivityTs = [
    ...feedback.map((e) => e.ts),
    ...decisions.map((e) => e.ts),
    ...review.map((e) => e.ts),
  ]
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    project,
    counts: {
      feedback: feedback.length,
      decisions: decisions.length,
      review: review.length,
      pendingReview: pendingReview.length,
      openFollowUps: openFollowUps.length,
    },
    lastActivityTs,
    samples: {
      recentFeedback: feedback.slice(-5).reverse(),
      recentDecisions: decisions.slice(-5).reverse(),
      pendingReview: pendingReview.slice(0, 5),
      openFollowUps: openFollowUps.slice(-5).reverse(),
    },
  };
}
