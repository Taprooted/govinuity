# Govinuity Architecture

This document explains how Govinuity works as a system — how the pieces connect, what happens at each step, and why the design is the way it is. It is written for contributors, evaluators, and agents working on the codebase.

For the decision data model and field-by-field semantics, see [`DECISION-SCHEMA.md`](./DECISION-SCHEMA.md). This document explains the system those fields exist within.

---

## The core problem

Agent sessions are stateless. Decisions, constraints, and patterns established in one session disappear when it ends. The naive solution — persist everything and retrieve it — creates a different problem: stale, superseded, or speculative content arrives as if it were settled governing instruction. There is no way to distinguish "we agreed on this three months ago and it still holds" from "someone mentioned this once and it was never confirmed."

Govinuity's answer is a governance layer between agent work and reuse. Decisions must earn their way into active context: proposed, reviewed by a human, ratified, then injected with a full audit trail. Every injection is logged. Every outcome is observable.

---

## The pipeline

```
Surface → Review → Ratify → Inject → Measure
```

Each step has a distinct role. Nothing skips a step.

| Step | What happens | Who acts |
|---|---|---|
| **Surface** | A candidate decision is submitted as a proposal | Agent, harvest script, or human |
| **Review** | A human sees the proposal with context: rationale, reversibility, conflict signals | Human |
| **Ratify** | Human approves, defers, rejects, or supersedes | Human |
| **Inject** | Eligible ratified decisions reach agent context | System (API or file) |
| **Measure** | The injection is logged; outcome signals are detected and annotated | System + harvest script |

---

## System components

```
┌─────────────────────────────────────────────────────┐
│                  Next.js local server                │
│                                                      │
│  app/                                                │
│    harvest/page.tsx     ← Harvest UI                 │
│    review/page.tsx      ← Review UI                  │
│    decisions/page.tsx   ← Decision log + injection   │
│    runs/page.tsx        ← Run history + annotations  │
│                                                      │
│  app/api/                                            │
│    decisions/           ← Proposal intake + CRUD     │
│    decisions/supersede/ ← Atomic supersession        │
│    memory/              ← Injection endpoint         │
│    continuity-file/     ← File-based injection       │
│    harvest/             ← UI-triggered harvesting    │
│    runs/                ← Run records                │
│    run-annotations/     ← Outcome signal storage     │
│    review-queue/        ← Review queue items         │
│    seed/                ← Example data (empty DB)    │
│                                                      │
│  lib/                                                │
│    db.ts                ← SQLite connection + schema │
│    decision-write.ts    ← Injection logic + audit    │
│    utils.ts             ← Eligibility computation    │
│    run-log.ts           ← Run record persistence     │
│    annotation-log.ts    ← Outcome annotation types   │
│                                                      │
├─────────────────────────────────────────────────────┤
│  scripts/harvest_proposals.py                        │
│    ← Session scanning, LLM extraction, dedup,        │
│       watermark, correction detection, annotation    │
├─────────────────────────────────────────────────────┤
│  data/govinuity.db      ← SQLite (all persistent state) │
│  data/harvest_meta.json ← Last harvest status        │
└─────────────────────────────────────────────────────┘
```

All state lives in `data/govinuity.db` (SQLite). There are no remote services.

---

## Step 1 — Surface

A proposal is any record in the `decisions` table with `status: "proposed"`. There are three ways to create one:

### 1a. Harvest pipeline (automated)

`scripts/harvest_proposals.py` reads session files, extracts candidates using an LLM, and submits them via `POST /api/decisions`.

**Session scanning:** By default it reads `~/.claude/projects/` (configurable via `GOVINUITY_SESSION_DIR`). Each project directory contains JSONL files — one per session — where each line is a message turn. The script uses a watermark (`~/.claude/proposal_harvest_watermark.json`) to track the last-processed turn per file, so incremental runs only process new content.

**Extraction:** Turns are chunked and passed to an LLM (Anthropic API via Instructor, or the Claude CLI as a fallback). The prompt asks the model to identify candidate decisions: things that were agreed upon, established, or constrained that would be worth carrying forward. The model returns structured `ProposalCandidate` objects with body, rationale, proposal class, confidence, and a `why_surfaced` explanation.

**Deduplication:** Before staging, each candidate is checked against existing decisions (both approved and proposed) using title word overlap. Candidates with ≥ 50% word overlap with an existing record are dropped as duplicates. This keeps the review queue clean on incremental runs.

**Text input mode (`--input`):** The `--input` flag accepts any file or stdin instead of scanning session files. Supported formats: labeled turns (`User:` / `Assistant:`), JSON messages arrays (OpenAI/Anthropic format), or raw text. This makes the extraction pipeline available for any agent tool. The Harvest UI's "Paste session text" mode uses this via the `POST /api/harvest` endpoint piping text to stdin.

**Correction detection:** In a separate pass, the script scans session content for outcome signals — patterns indicating that an injected decision was followed, ignored, corrected, or leaked as stale context. These are posted as run annotations via `POST /api/run-annotations`, closing the measurement loop without manual input.

### 1b. Harvest UI

The `/harvest` page provides two modes:

- **Scan session files** — triggers the harvest script via `POST /api/harvest` with a lookback window. Runs async; the server marks `running: true` in `data/harvest_meta.json` so the UI can poll and restore state across navigation.
- **Paste session text** — accepts pasted conversation content, posts it to `POST /api/harvest` with `mode: "text"`, which pipes it to the script via stdin.

### 1c. Direct API

Any system can submit a proposal directly:

```
POST /api/decisions
{ "body": "...", "status": "proposed", "proposal_class": "...", ... }
```

This is the integration point for agent frameworks, CI pipelines, or custom tooling. The `source_type`, `source_agent`, and `source_id` fields record provenance.

---

## Step 2 — Review

The `/review` page surfaces all proposals with `status: "proposed"` (and deferred items, if any). Each review card shows:

- `summary_for_human` — the human-readable summary written at submission time
- `body` — the full governing statement
- `rationale` — why this was surfaced or decided
- `why_surfaced` — what pattern triggered extraction (for harvest-sourced proposals)
- `reversibility` — how hard this is to undo (visual flag for low-reversibility items)
- `possible_conflicts` — declared conflicts with existing decisions
- `proposal_class` — the category of governing object

The review queue also includes items from the `review_queue` table — feedback, observations, and signals that have been flagged for human attention but are not decision candidates.

**Keyboard shortcuts** are available on the review page: `a` to approve, `d` to defer, `r` to reject, `↑/↓` to navigate.

---

## Step 3 — Ratify

Ratification is a status transition on the decision record. The API (`PATCH /api/decisions/:id`) accepts:

- `approved` — decision becomes eligible for injection. `ratified_by` is required.
- `deferred` — held for later; not injected but retained.
- `rejected` — not injected; retained in history.

**Supersession** is a special case: `POST /api/decisions/supersede` atomically inserts a new approved decision and marks one or more existing decisions as `superseded`. Both operations happen in a single database transaction. Superseded decisions are permanently excluded from injection — `superseded_by` is checked before any other eligibility criteria.

The `ratified_by` field is enforced on approval: the API rejects direct approval without a ratifier identity. This ensures every active decision has a named human in the ratification chain, which matters for the audit trail and for future multi-user governance.

---

## Step 4 — Inject

Injection is the step that delivers ratified decisions into agent context. There are two mechanisms.

### 4a. Memory API

```
GET /api/memory?project=<slug>&app=<app>&agent=<agent>
```

This is the primary injection interface. The call:

1. Evaluates all `approved` decisions against the request context using `getDecisionsWithAudit()` in `lib/decision-write.ts`
2. Returns eligible decisions in a lean JSON format suitable for system prompt use
3. Logs a continuity run record with the full audit trail (what was injected, what was excluded, and why)
4. Also returns memory files from `GOVINUITY_MEMORY_DIR` (markdown files with frontmatter)

### 4b. File-based injection

`POST /api/continuity-file` generates a `GOVERNED_CONTINUITY.md` file at a specified local path. The file contains the current active decisions formatted as markdown. Adding `@.claude/GOVERNED_CONTINUITY.md` to a `CLAUDE.md` file causes Claude Code to read it at the start of every session.

File-based injection also logs a continuity run, so the audit trail is maintained regardless of which injection mechanism is used.

### Eligibility evaluation

The function `computeEligibilityWithReason()` in `lib/utils.ts` evaluates each approved decision against the request context. Decisions are excluded for any of the following reasons (full taxonomy in `DECISION-SCHEMA.md`):

1. `superseded_by:<id>` — replaced by a newer decision
2. `tier:history_only` or `tier:re_ratify` — hard exclusion by transfer tier
3. `tier:explicit_not_requested` — explicit tier but caller did not opt in
4. `confidence_below_threshold` — confidence < 0.6
5. `expired:effective_until` — past hard expiry date
6. `stale:review_after_elapsed` — past review date, not renewed
7. `scope:*_mismatch` — scope doesn't match request context

After individual eligibility, conflict resolution runs: if two eligible decisions declare a conflict with each other (title word overlap ≥ 50%), only the more recently ratified one is injected. The other is excluded with reason `unresolved_conflict:<winning_id>`.

Every exclusion reason is machine-readable and appears in the run audit trail.

---

## Step 5 — Measure

### Continuity runs

Every call to `GET /api/memory` or use of the file generation panel creates a `continuity_run` record in the database. The record captures:

```
run_id          — unique identifier
ts              — timestamp
project/app     — request context
agent           — requesting agent identity
source          — injection mechanism (api, file, manual)
injected_ids    — array of decision IDs that were injected
excluded        — array of { id, title, reason } for excluded decisions
injected_count  — count injected
excluded_count  — count excluded
total_eligible  — total decisions evaluated
duration_ms     — time to evaluate and respond
```

This is the audit trail. The Runs page shows this history: what was active in each session, what was excluded and why.

### Run annotations

Outcome signals are attached to run records as annotations. Each annotation has a type:

| Type | Signal |
|---|---|
| `approved_decision_followed` | An injected decision was visibly applied in the session |
| `approved_decision_not_followed` | An injected decision was present but ignored |
| `continuity_correction_required` | The agent needed correction that a ratified decision should have prevented |
| `context_restatement_required` | Context had to be re-established that should have been carried forward |
| `stale_leakage_detected` | Stale or superseded content appeared in agent output |

Annotations can be:
- **Automatic** — the harvest script's correction detection pass identifies these signals in session content and posts them via `POST /api/run-annotations`
- **Manual** — added from the Runs page via the "Annotate manually" toggle

The harvest script associates annotations with the correct run by matching session timestamps against run records: it looks for a run whose `ts` falls within a 2-hour window of the session's first turn.

---

## Data layout

```
data/
  govinuity.db         — SQLite database
    decisions          — all proposals and ratified decisions
    continuity_runs    — injection run records
    run_annotations    — outcome signals per run
    review_queue       — non-decision signals for human review
    migrations         — applied schema migrations

  harvest_meta.json    — last harvest status (running flag, counts, output tail)

~/.claude/memory/      — markdown memory files (read by /api/memory)
  MEMORY.md            — index file
  *.md                 — individual memory entries with frontmatter

scripts/
  harvest_proposals.py — harvest pipeline
  .harvest_staged.json — staged candidates awaiting --submit
  proposal_harvest_watermark.json — per-session-file watermark (~/.claude/)
```

The database is the authoritative store. JSONL files (`decisions.jsonl`, `continuity_runs.jsonl`, `run_annotations.jsonl`) may exist from earlier versions and are seeded into the database on first run via migration `m001_seed_from_jsonl`.

---

## Key integration points

| Endpoint | What it does |
|---|---|
| `POST /api/decisions` | Submit a proposal from any source |
| `PATCH /api/decisions/:id` | Ratify: approve, defer, reject |
| `POST /api/decisions/supersede` | Atomically replace one or more decisions |
| `GET /api/memory` | Retrieve active decisions for a context; logs a run |
| `POST /api/continuity-file` | Generate a `GOVERNED_CONTINUITY.md` file |
| `POST /api/run-annotations` | Record an outcome signal for a run |
| `POST /api/harvest` | Trigger harvest from the UI (scan or text mode) |
| `GET /api/harvest` | Get last harvest status (running flag, counts) |

The harvest script is a reference implementation of the Surface step. Any system that can call `POST /api/decisions` can participate in surfacing. Any system that can call `GET /api/memory` or read a markdown file can consume ratified continuity.

---

## Design invariants

These are constraints that every change to the system should respect. They are not milestone goals — they are load-bearing properties of the architecture.

**The ratification step cannot be bypassed.** Only `approved` decisions with a `ratified_by` identity reach active context. There is no mechanism to inject a `proposed` or `deferred` decision directly. This is intentional and permanent.

**Every injection is logged.** The continuity run record is written on every `GET /api/memory` call and every file generation, regardless of what was injected. An empty run (0 decisions injected) is still a valid and useful record.

**Exclusion reasons are machine-readable.** Every decision excluded from injection has a reason code that can be parsed, aggregated, and displayed. Vague or unmachined exclusions are not acceptable.

**Supersession is atomic.** Replacing an existing decision and marking it superseded happens in a single database transaction. Partial supersession is not possible.

**Provenance without becoming a session warehouse.** Source references on proposals should be useful enough for review and audit — enough to understand where a proposal came from and why it was surfaced — but raw session content is not stored. The watermark tracks position; it does not archive turns.

**The review queue is a human's scarce resource.** Features that increase proposal volume without improving precision are net negative. Deduplication, confidence thresholding, and ranking exist to protect reviewer attention, not just to clean data.
