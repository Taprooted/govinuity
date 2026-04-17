# Govinuity

Governed continuity for human-agent work.

Agent systems are either stateless or too loosely persistent. Govinuity adds a governed continuity layer: candidate decisions are surfaced from ongoing agent work, reviewed by a human, and only then become reusable future context.

**Status:** early local-first release. The core loop works end-to-end, but the product surfaces are still evolving. Govinuity is most useful today for technically literate users experimenting with agent continuity, review-gated memory, and observable reuse.

**Feedback wanted:** does the loop make sense, does the quickstart work, are surfaced candidates useful enough to review, and do the run/outcome records help you understand whether continuity is working?

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
| **Surface** | Candidate decisions are extracted from pasted conversations, imported files, local session files, or direct API submissions. |
| **Review** | The Review page surfaces proposals for human assessment — with rationale, reversibility, and conflict signals |
| **Ratify** | You approve, defer, reject, or supersede. Only approved decisions become eligible for injection |
| **Inject** | On each session, eligible decisions are injected into agent context via API or a generated `GOVERNED_CONTINUITY.md` file |
| **Measure** | Every injection is logged as a continuity run with a full audit trail: what was injected, what was excluded and why |

This loop is the core of Govinuity. The rest is infrastructure for running it.

---

## What's in the repo

- **Next.js local dashboard** — governance UI running at `localhost:3000`
- **Harvest UI** — surface proposals from pasted conversations, imported files, local session scans, or API workflows; works with any agent tool that can provide text
- **Review UI** — human ratification of proposed decisions, with keyboard shortcuts
- **Decision memory API** — `GET /api/memory` returns active decisions scoped to the requesting context
- **Harvest script** — `scripts/harvest_proposals.py` extracts candidate decisions from session files, files, or stdin and detects outcome signals
- **Run logging and annotation** — every injection session is recorded; outcome annotations (decision followed, correction required, etc.) are posted automatically by the harvest script
- **Local SQLite persistence** — all data stays on your machine; no external services required

Stack: Next.js 16 / React 19 / TypeScript / SQLite (`better-sqlite3`) / Tailwind CSS 4

---

## What this is not

- **Not persistent memory by default** — context does not become authoritative just because it exists.
- **Not a manual review board only** — proposal intake can surface candidate decisions from ongoing work, then route them through review.
- **Not an agent orchestration platform** — Govinuity governs continuity; it does not schedule, delegate, or run agents.
- **Not a hosted SaaS** — this release is local-first, single-user, and trusted-local.

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

For a quick tour, use **Load example data** on the dashboard. That seeds proposed and ratified decisions so you can inspect the Review, Decisions, and Runs surfaces without first wiring in an agent workflow.

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
| **Harvest** | Extract candidate decisions from pasted text, imported files, local session scans, or API workflows |
| **Review** | Ratify proposed decisions; approve, defer, reject, or supersede |
| **Decisions** | Inspect the active decision log; generate `GOVERNED_CONTINUITY.md` for file-aware agents |
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

## Reusing ratified decisions

Govinuity is agent-platform agnostic at the continuity layer. Any tool that can receive text can use ratified decisions.

Common paths:

- **Copy context** — call `GET /api/memory` and paste the returned continuity context into an agent session.
- **Generate a file** — from the [Decisions](http://localhost:3000/decisions) page, generate `GOVERNED_CONTINUITY.md` and point a file-aware agent at it.
- **Call the API** — custom agents can call `GET /api/memory` at session start and `POST /api/run-annotations` later.

For Claude Code, enter a path such as `/your/project/.claude/GOVERNED_CONTINUITY.md`, then add one line to your `CLAUDE.md`:

```
@.claude/GOVERNED_CONTINUITY.md
```

Re-generate whenever decisions change — the panel tracks whether the file already exists and shows "Update" accordingly.

## API injection (agent-driven)

```
GET /api/memory?project=my-project&agent=my-agent
```

Returns active decisions filtered to the requested context, plus memory files. Logs a continuity run automatically.

---

## Harvesting — surfacing candidate decisions

The **Harvest** page (`/harvest`) is the primary way to surface candidate decisions. It starts from what you have: pasted conversation text, an exported file, or local JSONL session files. Harvested candidates are submitted as proposals for review. Session scans also run a correction detection pass — detecting signals like decisions followed, ignored, or requiring restatement — and post them as run annotations automatically.

**Two primary paths in the UI:**
- **Paste or upload** — recommended default. Paste any conversation export directly, or upload a transcript/log/messages file. Works for Codex, Claude, Cursor, ChatGPT, and other agents. You can label the input as a transcript, handoff summary, correction/lesson, subagent report, or working notes so extraction uses the right posture.
- **Scan local sessions** — scans local JSONL session files with guided presets: current project, parent folder, all Claude Code sessions, or custom directory. Includes a preflight count, warnings for broad/noisy scans, and browser auto-scan controls for repeated local intake while the tab is open.

The universal path is Paste or upload. Local scanning is the automated intake path for tools that write session files: it can keep the review queue supplied as ongoing work produces new candidate decisions. Claude Code JSONL sessions are supported today. The session directory is configurable — see `GOVINUITY_SESSION_DIR` in the [Configuration](#configuration) section.

**CLI / automation**

The harvest script can also be run directly, which is useful for durable cron jobs, local launch agents, or CI pipelines:

`scripts/harvest_proposals.py` uses Instructor + Anthropic SDK when available, or the Claude CLI as a fallback. It deduplicates against existing decisions and stages results for human review. Nothing is submitted without an explicit `--submit` flag.

**Requirements:** Python 3.9+. For Instructor extraction: `pip install pydantic anthropic instructor python-dotenv`. On Python 3.9, some Instructor/Pydantic versions may also require `eval_type_backport`; Python 3.10+ avoids that class of typing error. Without a working Anthropic/Instructor path, the script falls back to the Claude CLI if installed and authenticated separately. `python-dotenv` is optional but recommended so the script picks up your `.env.local` automatically.

If your system `python3` is older but another interpreter has the dependencies installed, set `GOVINUITY_PYTHON_BIN` before running the web app:

```bash
GOVINUITY_PYTHON_BIN=/opt/homebrew/bin/python3.11 npm run dev
```

By default, the script looks for the Claude Code session directory matching the current repo path. If it cannot find that directory, it falls back to `~/.claude/projects`. It processes the newest 25 matching session files by default to avoid slow, noisy all-history scans. Non-Claude users can use `--input` with transcripts, exported messages, or stdin.

```bash
# Submit proposals from the last 48 hours
python3 scripts/harvest_proposals.py --submit

# Preview without writing
python3 scripts/harvest_proposals.py --dry-run

# Custom lookback
python3 scripts/harvest_proposals.py --submit --since 7d

# Debug a scan without the previous watermark, limited to the newest files
python3 scripts/harvest_proposals.py --dry-run --no-watermark --max-files 5

# From a file (Codex, Cursor, LangGraph, OpenAI, etc.)
python3 scripts/harvest_proposals.py --input session.txt --source codex --submit

# From a handoff or compact summary
python3 scripts/harvest_proposals.py --input examples/harvest-handoff.txt --source codex --artifact-type handoff_summary --dry-run

# From a correction or lesson learned
python3 scripts/harvest_proposals.py --input examples/harvest-correction.txt --source codex --artifact-type correction_or_lesson --dry-run

# From a synthesized subagent report
python3 scripts/harvest_proposals.py --input examples/harvest-subagent-report.txt --source codex --artifact-type subagent_report --dry-run

# From stdin
cat session.txt | python3 scripts/harvest_proposals.py --input - --source cursor --submit
```

Supported `--input` formats:
- **Labeled turns** — lines starting with `User:`, `Human:`, `Assistant:`, `Claude:`, or `AI:`
- **Messages JSON** — a JSON array of `{"role": "...", "content": "..."}` objects (OpenAI/Anthropic format)
- **Raw text** — treated as a single block for extraction

The `--source` label is recorded on surfaced candidates for provenance. The script tracks a watermark per session file so incremental runs only process new turns.

For pasted or imported text, `--artifact-type` can guide extraction:
- `transcript` — normal conversation or exported chat
- `handoff_summary` — compact summary or next-session brief
- `correction_or_lesson` — failed approach, correction, or do-not-repeat note
- `subagent_report` — synthesized report from delegated work
- `working_notes` — mixed notes or scratch material

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
| `GOVINUITY_HARVEST_MAX_FILES` | `25` | Maximum newest session files scanned per harvest run. |

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

## Contact and feedback

For questions, early-user feedback, or implementation notes: [hello@govinuity.com](mailto:hello@govinuity.com).

If you are testing the repo, the most useful feedback is whether the governed continuity loop is clear, whether surfaced candidates are worth reviewing, and whether run/outcome records make reuse more inspectable.

---

## Current status

- **Local-first** — no remote services, no accounts, no telemetry
- **No authentication** — intended for single-user or trusted local use
- **Early public release** — core pipeline (surface → review → ratify → inject → measure) is functional; some secondary surfaces are still evolving
- Tested on macOS; should work on Linux; Windows untested

---

## License

MIT — see [LICENSE](LICENSE).
