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
| **Surface** | An agent (or you) submits a candidate decision via `POST /api/decisions` with `status: "proposed"`. The harvest script (`scripts/harvest_proposals.py`) can do this automatically by reading Claude Code session files. |
| **Review** | The Review page surfaces proposals for human assessment — with rationale, reversibility, and conflict signals |
| **Ratify** | You approve, defer, reject, or supersede. Only approved decisions become eligible for injection |
| **Inject** | On each session, eligible decisions are injected into agent context via API or a generated `GOVERNED_CONTINUITY.md` file |
| **Measure** | Every injection is logged as a continuity run with a full audit trail: what was injected, what was excluded and why |

This loop is the core of Govinuity. The rest is infrastructure for running it.

---

## What's in the repo

- **Next.js local dashboard** — governance UI running at `localhost:3000`
- **Review UI** — human ratification of proposed decisions, with keyboard shortcuts
- **Decision memory API** — `GET /api/memory` returns active decisions scoped to the requesting context
- **Harvest script** — `scripts/harvest_proposals.py` reads Claude Code session files and extracts candidate decisions automatically
- **Run logging and annotation** — every injection session is recorded and can be annotated (decision followed? correction required?)
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
| **Review** | Ratify proposed decisions; approve, defer, reject, or supersede |
| **Decisions** | Inspect the active decision log; generate `GOVERNED_CONTINUITY.md` for Claude Code |
| **Runs** | Continuity run history — what was injected per session, exclusion reasons, outcome annotations |

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

## Automated surfacing with the harvest script

`scripts/harvest_proposals.py` closes the Surface and Measure steps of the loop automatically. It extracts candidate decisions using Claude (via Instructor + Anthropic SDK, or the Claude CLI as a fallback), deduplicates against existing decisions, and stages results for your review. Nothing is submitted without an explicit flag.

It also runs a **correction detection pass** — detecting signals like continuity corrections, context restatements, decisions followed or ignored, and stale leakage. When `--submit` is active, these are automatically posted as run annotations, closing the measurement loop without manual input.

**Requirements:** Python 3.9+, `pip install pydantic anthropic instructor python-dotenv` (or just `pydantic` for CLI fallback; `python-dotenv` is optional but recommended so the script picks up your `.env.local` automatically)

```bash
# Stage candidates from the last 48 hours (default — reads Claude Code sessions)
python3 scripts/harvest_proposals.py

# Preview without writing
python3 scripts/harvest_proposals.py --dry-run

# Stage + submit to /api/decisions
python3 scripts/harvest_proposals.py --submit

# Process a specific Claude Code session file
python3 scripts/harvest_proposals.py --session ~/.claude/projects/my-project/session.jsonl
```

The script reads `~/.claude/projects/` by default — the standard location for Claude Code session files. It tracks a watermark per session file so incremental runs only process new turns.

**Other agent tools — `--input`**

The `--input` flag accepts any text file or stdin, making the extraction pipeline available for any agent system that can export session content:

```bash
# From a file (Cursor, LangGraph, etc.)
python3 scripts/harvest_proposals.py --input session.txt --source cursor

# OpenAI / Anthropic messages JSON format
python3 scripts/harvest_proposals.py --input messages.json --source openai-assistants

# Pipe from stdin
cat session.txt | python3 scripts/harvest_proposals.py --input - --source langgraph
```

Supported input formats:
- **Labeled turns** — lines starting with `User:`, `Human:`, `Assistant:`, `Claude:`, or `AI:`
- **Messages JSON** — a JSON array of `{"role": "...", "content": "..."}` objects (OpenAI/Anthropic format)
- **Raw text** — treated as a single block for extraction

The `--source` label is recorded on surfaced candidates for provenance. Text inputs do not update the watermark — they are treated as one-shot.

**Cron (every 4 hours):**
```
0 */4 * * * cd /path/to/govinuity && python3 scripts/harvest_proposals.py >> scripts/harvest.log 2>&1
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GOVINUITY_META_DIR` | `./data` | Directory for the SQLite database and JSONL files |
| `GOVINUITY_MEMORY_DIR` | `~/.claude/memory` | Directory for Claude Code memory files (read by `/api/memory`) |

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

- [`docs/DECISION-SCHEMA.md`](docs/DECISION-SCHEMA.md) — full decision data model: lifecycle, proposal classes, transfer tiers, scope, confidence, temporal fields, supersession, and the complete injection eligibility taxonomy
- [`docs/semantic-backfill.md`](docs/semantic-backfill.md) — normalizing legacy JSONL records

---

## Current status

- **Local-first** — no remote services, no accounts, no telemetry
- **No authentication** — intended for single-user or trusted local use
- **Early public release** — core loop (surface → review → ratify → inject → observe) is functional; some secondary surfaces are still evolving
- Tested on macOS; should work on Linux; Windows untested

---

## License

MIT — see [LICENSE](LICENSE).
