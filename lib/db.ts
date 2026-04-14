import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { PATHS } from "./config";
import { readJsonlWithWarnings } from "./jsonl";

export const DB_PATH = path.join(PATHS.metaDir, "govinuity.db");

// JSON columns in the decisions table that must be parsed/serialized at boundary
const DECISION_JSON_COLS = [
  "supersedes", "related_objects", "assumptions", "tags",
  "context_keys", "possible_conflicts", "provenance",
] as const;

// Survive Next.js hot reloads in development by caching on global
const g = global as typeof global & { __govinuity_db?: Database.Database };

export function getDb(): Database.Database {
  if (g.__govinuity_db) return g.__govinuity_db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL"); // safe with WAL
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  initSchema(db);
  runMigrations(db);

  g.__govinuity_db = db;
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      body TEXT NOT NULL,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      scope TEXT DEFAULT 'global',
      scope_ref TEXT,
      transfer_tier TEXT DEFAULT 'always',
      confidence REAL DEFAULT 0.8,
      ratified_by TEXT,
      created_at TEXT,
      updated_at TEXT,
      review_after TEXT,
      effective_until TEXT,
      supersedes TEXT DEFAULT '[]',
      superseded_by TEXT,
      follow_up_state TEXT DEFAULT 'open',
      proposal_class TEXT,
      summary_for_human TEXT,
      why_surfaced TEXT,
      reversibility TEXT,
      possible_conflicts TEXT DEFAULT '[]',
      reuse_instructions TEXT,
      revisit_trigger TEXT,
      note TEXT,
      tags TEXT DEFAULT '[]',
      context_keys TEXT DEFAULT '[]',
      assumptions TEXT DEFAULT '[]',
      source_type TEXT,
      source_agent TEXT,
      source_id TEXT,
      source_loop TEXT,
      provenance TEXT DEFAULT '{}',
      related_objects TEXT DEFAULT '[]',
      context TEXT
    );

    CREATE TABLE IF NOT EXISTS continuity_runs (
      run_id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      project TEXT,
      app TEXT,
      agent TEXT,
      source TEXT,
      injected_ids TEXT DEFAULT '[]',
      excluded TEXT DEFAULT '[]',
      injected_count INTEGER DEFAULT 0,
      excluded_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS run_annotations (
      annotation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      annotation_type TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 1,
      decision_id TEXT,
      note TEXT,
      annotated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS review_queue (
      id TEXT PRIMARY KEY,
      original_entry TEXT NOT NULL,
      reviewed INTEGER DEFAULT 0,
      decision TEXT,
      note TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT,
      project TEXT,
      follow_up_state TEXT DEFAULT 'open',
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_decisions_status     ON decisions(status);
    CREATE INDEX IF NOT EXISTS idx_decisions_project_id ON decisions(project_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_review_after ON decisions(review_after);
    CREATE INDEX IF NOT EXISTS idx_decisions_transfer_tier ON decisions(transfer_tier);
    CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_project         ON continuity_runs(project);
    CREATE INDEX IF NOT EXISTS idx_runs_ts              ON continuity_runs(ts);
    CREATE INDEX IF NOT EXISTS idx_annotations_run_id  ON run_annotations(run_id);
    CREATE INDEX IF NOT EXISTS idx_annotations_type    ON run_annotations(annotation_type);
  `);
}

function runMigrations(db: Database.Database): void {
  const m001 = db.prepare("SELECT name FROM migrations WHERE name = ?").get("m001_seed_from_jsonl");
  if (!m001) {
    seedFromJsonl(db);
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
      "m001_seed_from_jsonl",
      new Date().toISOString(),
    );
  }
  const m002 = db.prepare("SELECT name FROM migrations WHERE name = ?").get("m002_seed_review_queue");
  if (!m002) {
    seedReviewQueue(db);
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
      "m002_seed_review_queue",
      new Date().toISOString(),
    );
  }

  const m003 = db.prepare("SELECT name FROM migrations WHERE name = ?").get("m003_run_fields");
  if (!m003) {
    // Add observability fields to continuity_runs (safe — ALTER TABLE ADD COLUMN is idempotent in SQLite)
    for (const ddl of [
      "ALTER TABLE continuity_runs ADD COLUMN duration_ms INTEGER",
      "ALTER TABLE continuity_runs ADD COLUMN total_eligible INTEGER DEFAULT 0",
      "ALTER TABLE continuity_runs ADD COLUMN task_ref TEXT",
    ]) {
      try { db.exec(ddl); } catch { /* column already exists — safe to ignore */ }
    }
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
      "m003_run_fields",
      new Date().toISOString(),
    );
  }
}

function seedFromJsonl(db: Database.Database): void {
  // --- decisions ---
  const decisionsPath = path.join(PATHS.metaDir, "decisions.jsonl");
  if (fs.existsSync(decisionsPath)) {
    const { entries } = readJsonlWithWarnings(decisionsPath, "decisions.jsonl");
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO decisions (
        id, project_id, title, body, rationale, status, scope, scope_ref,
        transfer_tier, confidence, ratified_by, created_at, updated_at,
        review_after, effective_until, supersedes, superseded_by, follow_up_state,
        proposal_class, summary_for_human, why_surfaced, reversibility,
        possible_conflicts, reuse_instructions, revisit_trigger, note,
        tags, context_keys, assumptions, source_type, source_agent, source_id,
        source_loop, provenance, related_objects, context
      ) VALUES (
        @id, @project_id, @title, @body, @rationale, @status, @scope, @scope_ref,
        @transfer_tier, @confidence, @ratified_by, @created_at, @updated_at,
        @review_after, @effective_until, @supersedes, @superseded_by, @follow_up_state,
        @proposal_class, @summary_for_human, @why_surfaced, @reversibility,
        @possible_conflicts, @reuse_instructions, @revisit_trigger, @note,
        @tags, @context_keys, @assumptions, @source_type, @source_agent, @source_id,
        @source_loop, @provenance, @related_objects, @context
      )
    `);
    const seed = db.transaction((rows: any[]) => {
      for (const e of rows) {
        stmt.run({
          id: e.id ?? `dec-legacy-${Math.random().toString(36).slice(2)}`,
          project_id: e.project_id ?? null,
          title: e.title ?? null,
          body: e.body ?? e.proposal ?? "",
          rationale: e.rationale ?? null,
          status: e.status ?? e.decision ?? "proposed",
          scope: e.scope ?? "global",
          scope_ref: e.scope_ref ?? null,
          transfer_tier: e.transfer_tier ?? "always",
          confidence: e.confidence ?? 0.8,
          ratified_by: e.ratified_by ?? null,
          created_at: e.created_at ?? e.ts ?? null,
          updated_at: e.updated_at ?? e.ts ?? null,
          review_after: e.review_after ?? null,
          effective_until: e.effective_until ?? null,
          supersedes: JSON.stringify(Array.isArray(e.supersedes) ? e.supersedes : []),
          superseded_by: e.superseded_by ?? null,
          follow_up_state: e.follow_up_state ?? "open",
          proposal_class: e.proposal_class ?? null,
          summary_for_human: e.summary_for_human ?? null,
          why_surfaced: e.why_surfaced ?? null,
          reversibility: e.reversibility ?? null,
          possible_conflicts: JSON.stringify(Array.isArray(e.possible_conflicts) ? e.possible_conflicts : []),
          reuse_instructions: e.reuse_instructions ?? null,
          revisit_trigger: e.revisit_trigger ?? null,
          note: e.note ?? null,
          tags: JSON.stringify(Array.isArray(e.tags) ? e.tags : []),
          context_keys: JSON.stringify(Array.isArray(e.context_keys) ? e.context_keys : []),
          assumptions: JSON.stringify(Array.isArray(e.assumptions) ? e.assumptions : []),
          source_type: e.source_type ?? null,
          source_agent: e.source_agent ?? null,
          source_id: e.source_id ?? null,
          source_loop: e.source_loop ?? null,
          provenance: JSON.stringify(e.provenance ?? {}),
          related_objects: JSON.stringify(Array.isArray(e.related_objects) ? e.related_objects : []),
          context: e.context ?? null,
        });
      }
    });
    seed(entries);
  }

  // --- continuity_runs ---
  const runsPath = path.join(PATHS.metaDir, "continuity_runs.jsonl");
  if (fs.existsSync(runsPath)) {
    const { entries } = readJsonlWithWarnings(runsPath, "continuity_runs.jsonl");
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO continuity_runs
        (run_id, ts, project, app, agent, source, injected_ids, excluded, injected_count, excluded_count)
      VALUES
        (@run_id, @ts, @project, @app, @agent, @source, @injected_ids, @excluded, @injected_count, @excluded_count)
    `);
    const seed = db.transaction((rows: any[]) => {
      for (const e of rows) {
        stmt.run({
          run_id: e.run_id,
          ts: e.ts,
          project: e.project ?? null,
          app: e.app ?? null,
          agent: e.agent ?? null,
          source: e.source ?? null,
          injected_ids: JSON.stringify(Array.isArray(e.injected_ids) ? e.injected_ids : []),
          excluded: JSON.stringify(Array.isArray(e.excluded) ? e.excluded : []),
          injected_count: e.injected_count ?? 0,
          excluded_count: e.excluded_count ?? 0,
        });
      }
    });
    seed(entries);
  }

  // --- run_annotations ---
  const annotPath = path.join(PATHS.metaDir, "run_annotations.jsonl");
  if (fs.existsSync(annotPath)) {
    const { entries } = readJsonlWithWarnings(annotPath, "run_annotations.jsonl");
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO run_annotations
        (annotation_id, run_id, ts, annotation_type, value, decision_id, note, annotated_by)
      VALUES
        (@annotation_id, @run_id, @ts, @annotation_type, @value, @decision_id, @note, @annotated_by)
    `);
    const seed = db.transaction((rows: any[]) => {
      for (const e of rows) {
        stmt.run({
          annotation_id: e.annotation_id,
          run_id: e.run_id,
          ts: e.ts,
          annotation_type: e.annotation_type,
          value: e.value ? 1 : 0,
          decision_id: e.decision_id ?? null,
          note: e.note ?? null,
          annotated_by: e.annotated_by ?? null,
        });
      }
    });
    seed(entries);
  }
}

function seedReviewQueue(db: Database.Database): void {
  const queuePath = path.join(PATHS.metaDir, "review_queue.jsonl");
  if (!fs.existsSync(queuePath)) return;
  const { entries } = readJsonlWithWarnings(queuePath, "review_queue.jsonl");
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO review_queue
      (id, original_entry, reviewed, decision, note, reviewed_at, reviewed_by, project, follow_up_state, created_at)
    VALUES
      (@id, @original_entry, @reviewed, @decision, @note, @reviewed_at, @reviewed_by, @project, @follow_up_state, @created_at)
  `);
  const seed = db.transaction((rows: any[]) => {
    for (const e of rows) {
      const oe = e.original_entry ?? {};
      stmt.run({
        id: oe.id ?? e.id ?? `rq-legacy-${Math.random().toString(36).slice(2)}`,
        original_entry: JSON.stringify(oe),
        reviewed: e.reviewed ? 1 : 0,
        decision: e.decision ?? null,
        note: e.note ?? null,
        reviewed_at: e.reviewed_at ?? null,
        reviewed_by: e.reviewed_by ?? null,
        project: e.project ?? null,
        follow_up_state: e.follow_up_state ?? "open",
        created_at: oe.ts ?? e.created_at ?? null,
      });
    }
  });
  seed(entries);
}

/** Parse JSON columns in a raw decision row back to their object/array form. */
export function parseDecisionRow(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const col of DECISION_JSON_COLS) {
    if (typeof out[col] === "string") {
      try { out[col] = JSON.parse(out[col] as string); } catch { /* leave as string */ }
    }
  }
  return out;
}

/** Serialize a decision object's JSON columns to strings for storage. */
export function serializeDecisionFields(entry: Record<string, unknown>): Record<string, unknown> {
  const out = { ...entry };
  for (const col of DECISION_JSON_COLS) {
    if (out[col] !== undefined && typeof out[col] !== "string") {
      out[col] = JSON.stringify(out[col] ?? (col === "provenance" ? {} : []));
    }
  }
  return out;
}
