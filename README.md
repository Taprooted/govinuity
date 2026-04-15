# Govinuity

Governed continuity for human-agent work.

Agent systems are either stateless or too loosely persistent. Govinuity adds a governed continuity layer: candidate decisions are surfaced from ongoing agent work, reviewed by a human, and only then become reusable future context.

---

## Why this exists

- **Stateless agents forget too much.** Each session starts cold — prior decisions, constraints, and patterns are gone.
- **Naive persistence carries too much forward.** Storing everything and retrieving it creates false authority. A speculative suggestion looks identical to a settled constraint.
- **Proposals get mistaken for decisions.** Without a ratification step, agents treat candidate ideas as governing instructions.
- **Teams need auditability.** Which decisions were active in a given session? Which were excluded and why? Who ratified what?

---

## The governed continuity loop

```
Surface → Review → Ratify → Inject → Measure
```

| Step | What happens |
|---|---|
| **Surface** | Candidate decisions are extracted from agent session files via the **Harvest** page or `scripts/harvest_proposals.py`. Proposals can also be submitted directly via `POST /api/decisions`. |
| **Review** | The Review page surfaces proposals for human assessment — with rationale, reversibility, and conflict signals |
| **Ratify** | You approve, defer, reject, or supersede. Only approved decisions become eligible for injection |
| **Inject** | On each session, eligible decisions are injected into agent context via API or a generated `GOVERNED_CONTINUITY.md` file |
| **Measure** | Every injection is logged as a continuity run with a full audit trail: what was injected, what was excluded and why |

This loop is the core of Govinuity. The rest is infrastructure for running it.

---

## What's in the repo

- **Next.js local dashboard** — governance UI running at `localhost:3000`
- **Harvest UI** — trigger extraction from session files or paste conversation text directly; auto-harvest on a timer; works with any agent tool
- **Review UI** — human ratification of proposed decisions, with keyboard shortcuts
- **Decision memory API** — `GET /api/memory` returns active decisions scoped to the requesting context
- **Harvest script** — `scripts/harvest_proposals.py` extracts candidate decisions from session files and detects outcome signals; runs automatically or via the UI
- **Run logging and annotation** — every injection session is recorded; outcome annotations (decision followed, correction required, etc.) are posted automatically by the harvest script
- **Local SQLite persistence** — all data stays on your machine; no external services required

Stack: Next.js 16 / React 19 / TypeScript / SQLite (`better-sqlite3`) / Tailwind CSS 4

---

## Quickstart

**Requirements:** Node.js 18+

```bash
git clone https://github.com/Taprooted/govinuity.git
cd govinuity
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

The `data/` directory and database are created automatically on first run.

> **Trusted-local only.** Govinuity has no authentication. Run it on your local machine or a private, trusted environment. Do not expose it to shared networks or the public internet.

**Send your first proposal:**

```bash
curl -X POST http://localhost:3000/api/decisions \
  -H "Content-Type: application/json" \
  -d '{
    "body": "All database migrations must be reviewed by a human before running in production.",
    "status": "proposed",
    "proposal_class": "durable_constraint",
    "summary_for_human": "Prevents unreviewed migrations from reaching production.",
    "rationale": "A bad migration is hard to reverse and can cause data loss."
  }'
```

Then open [/review](http://localhost:3000/review) and ratify it.

---

## What you'll see

| Surface | Purpose |
|---|---|
| **Dashboard** | Governance pulse — pending review, ratified decisions, run metrics, outcome signals |
| **Harvest** | Extract candidate decisions from session files or pasted text; trigger auto-harvest on a timer |
| **Review** | Ratify proposed decisions; approve, defer, reject, or supersede |
| **Decisions** | Inspect the active decision log; generate `GOVERNED_CONTINUITY.md` for Claude Code |
| **Runs** | Injection history — what was injected per session, exclusion reasons, outcome annotations |

---

## Key concepts

**Decision** — A ratified governing statement: a constraint, a workflow rule, an architectural choice. Carries scope, confidence, and temporal bounds. Only approved decisions are eligible for injection.

**Transfer tier** — Controls when a decision is injected: `always` (every session), `by_project` (only when a project context is specified), `explicit` (only when explicitly requested), `history_only` / `re_ratify` (never injected automatically). See [`docs/DECISION-SCHEMA.md`](docs/DECISION-SCHEMA.md).

**Scope** — Which context a decision applies to: `global`, `project`, `app`, `task`, `session`, or `agent`. Project-scoped decisions are only injected when the requesting session provides a matching project identifier.

**Supersession** — Replacing one or more existing decisions with a new one, atomically. The old decisions are marked `superseded` and permanently excluded from injection.

**Continuity run** — A logged injection event. Every call to `GET /api/memory` or use of the Generate panel creates a run record with the full list of injected and excluded decisions, including the exclusion reason for each.

**Review queue** — Incoming signals (feedback, observations, proposals) that have been flagged for human attention but not yet acted on. Separate from the decisions table.

---

## Injecting decisions into Claude Code

From the [Decisions](http://localhost:3000/decisions) page, use the **Generate for Claude Code** panel. Enter the path where you want the file written (e.g. `/your/project/.claude/GOVERNED_CONTINUITY.md`), then add one line to your `CLAUDE.md`:

```
@.claude/GOVERNED_CONTINUITY.md
```

Claude Code reads your ratified decisions at the start of every session. Re-generate whenever decisions change — the panel tracks whether the file already exists and shows "Update" accordingly.

## API injection (agent-driven)

```
GET /api/memory?project=my-project&agent=my-agent
```

Returns active decisions filtered to the requested context, plus memory files. Logs a continuity run automatically.

---

## Harvesting — surfacing candidate decisions

The **Harvest** page (`/harvest`) is the primary way to surface candidate decisions. It scans session files in a configured directory, extracts candidates, and submits them as proposals for review. It also runs a correction detection pass — detecting signals like decisions followed, ignored, or requiring restatement — and posts them as run annotations automatically.

**Two modes in the UI:**
- **Scan session files** — scans the configured session directory with a lookback window (4h / 24h / 48h / 7d). Supports auto-harvest on a timer (browser-based).
- **Paste session text** — paste any conversation export directly. Accepts labeled turns (`User:` / `Assistant:`), a JSON messages array, or raw text. Select a source label (Cursor, OpenAI Assistants, LangGraph, etc.) for provenance.

The session directory defaults to `~/.claude/projects` but is configurable — see `GOVINUITY_SESSION_DIR` in the [Configuration](#configuration) section.

**CLI / automation**

The harvest script can also be run directly, which is useful for cron jobs or CI pipelines:

`scripts/harvest_proposals.py` uses Instructor + Anthropic SDK when available, or the Claude CLI as a fallback. It deduplicates against existing decisions and stages results for human review. Nothing is submitted without an explicit `--submit` flag.

**Requirements:** Python 3.9+. For Instructor extraction: `pip install pydantic anthropic instructor python-dotenv`. On Python 3.9, some Instructor/Pydantic versions may also require `eval_type_backport`; without a working Anthropic/Instructor path, the script falls back to the Claude CLI if installed and authenticated separately. `python-dotenv` is optional but recommended so the script picks up your `.env.local` automatically.

```bash
# Submit proposals from the last 48 hours
python3 scripts/harvest_proposals.py --submit

# Preview without writing
python3 scripts/harvest_proposals.py --dry-run

# Custom lookback
python3 scripts/harvest_proposals.py --submit --since 7d

# From a file (Cursor, LangGraph, OpenAI Assistants, etc.)
python3 scripts/harvest_proposals.py --input session.txt --source cursor --submit

# From stdin
cat session.txt | python3 scripts/harvest_proposals.py --input - --source langgraph --submit
```

Supported `--input` formats:
- **Labeled turns** — lines starting with `User:`, `Human:`, `Assistant:`, `Claude:`, or `AI:`
- **Messages JSON** — a JSON array of `{"role": "...", "content": "..."}` objects (OpenAI/Anthropic format)
- **Raw text** — treated as a single block for extraction

The `--source` label is recorded on surfaced candidates for provenance. The script tracks a watermark per session file so incremental runs only process new turns.

**Cron (every 4 hours):**
```
0 */4 * * * cd /path/to/govinuity && python3 scripts/harvest_proposals.py --submit >> scripts/harvest.log 2>&1
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GOVINUITY_META_DIR` | `./data` | Directory for the SQLite database and JSONL files |
| `GOVINUITY_MEMORY_DIR` | `~/.claude/memory` | Directory for Claude Code memory files (read by `/api/memory`) |
| `GOVINUITY_SESSION_DIR` | `~/.claude/projects` | Directory scanned for JSONL session files during harvest. Override to point at another tool's session export directory. |

Copy `.env.example` to `.env.local` and uncomment lines you want to override.

---

## Data layout

```
data/
  govinuity.db      # SQLite — decisions, runs, review queue, annotations
  feedback.jsonl    # Feedback entries
  memory/           # Memory files (markdown with frontmatter)
```

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the system works end-to-end: components, pipeline steps, injection eligibility, continuity runs, outcome measurement, data layout, integration points, and design invariants
- [`docs/DECISION-SCHEMA.md`](docs/DECISION-SCHEMA.md) — full decision data model: lifecycle, proposal classes, transfer tiers, scope, confidence, temporal fields, supersession, and the complete injection eligibility taxonomy
- [`docs/semantic-backfill.md`](docs/semantic-backfill.md) — normalizing legacy JSONL records

---

## Current status

- **Local-first** — no remote services, no accounts, no telemetry
- **No authentication** — intended for single-user or trusted local use
- **Early public release** — core pipeline (surface → review → ratify → inject → measure) is functional; some secondary surfaces are still evolving
- Tested on macOS; should work on Linux; Windows untested

---

## License

MIT — see [LICENSE](LICENSE).
