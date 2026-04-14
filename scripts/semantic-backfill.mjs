import fs from "fs";
import path from "path";

const META_DIR = process.env.GOVINUITY_META_DIR ?? path.join(process.cwd(), "data");
const PROJECTS_PATH = path.join(process.cwd(), "projects.json");

function loadProjects() {
  if (!fs.existsSync(PROJECTS_PATH)) return [];
  return JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf-8"));
}

function contextMatchesProject(context, project) {
  if (!context) return false;
  return (project.context_keys ?? []).some((key) => context === key || context.startsWith(`${key}:`));
}

function inferProjectFromContext(context, projects) {
  if (!context) return null;
  return projects.find((project) => contextMatchesProject(context, project))?.slug ?? null;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && (!(Array.isArray(v)) || v.length > 0)));
}

function normalizeFeedbackEntry(entry, projects) {
  return compactObject({
    ...entry,
    project: entry.project ?? inferProjectFromContext(entry.context, projects),
  });
}

function normalizeReviewItem(entry, projects) {
  const reviewId = entry.original_entry?.id;
  const context = entry.original_entry?.context;
  return compactObject({
    ...entry,
    project: entry.project ?? inferProjectFromContext(context, projects),
    provenance: entry.provenance ?? (reviewId ? compactObject({ sourceEntryId: reviewId, derivedFrom: [reviewId] }) : undefined),
  });
}

function normalizeDecisionEntry(entry, projects) {
  const reviewItemId = entry.provenance?.reviewItemId ?? entry.id;
  const decidedAt = entry.provenance?.decidedAt ?? entry.ts;
  const baseProvenance = entry.provenance ?? {};
  return compactObject({
    ...entry,
    project: entry.project ?? inferProjectFromContext(entry.context, projects),
    provenance: compactObject({
      sourceEntryId: baseProvenance.sourceEntryId ?? reviewItemId,
      reviewItemId: baseProvenance.reviewItemId ?? reviewItemId,
      decisionId: baseProvenance.decisionId,
      linkType: baseProvenance.linkType ?? "legacy-normalized",
      decidedAt,
      derivedFrom: baseProvenance.derivedFrom ?? (reviewItemId ? [reviewItemId] : undefined),
    }),
  });
}

function normalizeByFile(name, entry, projects) {
  if (name === "feedback.jsonl") return normalizeFeedbackEntry(entry, projects);
  if (name === "review_queue.jsonl") return normalizeReviewItem(entry, projects);
  if (name === "decisions.jsonl") return normalizeDecisionEntry(entry, projects);
  return entry;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeJsonlAtomic(filePath, entries) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  const content = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  fs.writeFileSync(tempPath, content, "utf-8");
  fs.renameSync(tempPath, filePath);
}

function diffCount(before, after) {
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) {
    if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) changed += 1;
  }
  return changed;
}

const dryRun = !process.argv.includes("--write");
const projects = loadProjects();
const files = ["feedback.jsonl", "review_queue.jsonl", "decisions.jsonl"];

for (const name of files) {
  const filePath = path.join(META_DIR, name);
  const entries = readJsonl(filePath);
  const normalized = entries.map((entry) => normalizeByFile(name, entry, projects));
  const changed = diffCount(entries, normalized);
  const missingProject = normalized.filter((entry) => !entry.project).length;
  const missingProvenance = name === "decisions.jsonl" ? normalized.filter((entry) => !entry.provenance).length : 0;
  const unresolvedContexts = Array.from(new Set(
    normalized
      .filter((entry) => !entry.project)
      .map((entry) => entry.context ?? entry.original_entry?.context)
      .filter(Boolean),
  ));

  console.log(`${name}: total=${entries.length} changed=${changed} missing_project_after=${missingProject}${name === "decisions.jsonl" ? ` missing_provenance_after=${missingProvenance}` : ""}`);
  if (unresolvedContexts.length > 0) {
    console.log(`  unresolved_contexts=${unresolvedContexts.join(", ")}`);
  }

  if (!dryRun && changed > 0) {
    writeJsonlAtomic(filePath, normalized);
    console.log(`wrote ${name}`);
  }
}

if (dryRun) {
  console.log("dry-run only; re-run with --write to persist normalized JSONL files");
}
