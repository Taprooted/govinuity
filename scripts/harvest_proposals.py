#!/usr/bin/env python3
"""
Harvest — governed extraction pipeline for durable continuity proposals.

Reads agent session content, extracts candidate decisions worth persisting
across sessions, deduplicates, and stages them for human review.
Nothing is submitted to Govinuity without an explicit --submit flag.

Sources:
  - Claude Code session JSONL files (default — reads ~/.claude/projects/)
  - Any text file or stdin via --input (plain labeled turns, OpenAI/Anthropic
    message JSON, or raw text)

Pipeline:
  1. Session selection    — only recent sessions by default (48h)
  2. Turn loading         — user + assistant text
  3. Per-chunk extraction — raw candidates extracted per 60-turn chunk.
                            Uses Instructor + Anthropic SDK when ANTHROPIC_API_KEY is set,
                            falls back to subprocess Claude CLI otherwise.
  4. Consolidation        — merge dupes, drop non-settled + low-trust candidates,
                            keep only durable classes
  5. Deduplication        — filter against existing decisions in the database
  6. Correction detection — one pass per session to detect continuity outcome signals
                            (correction required, context restated, decision followed/not followed,
                            stale leakage). Matched to a continuity run and auto-annotated.
  7. Staging              — write to .harvest_staged.json (never auto-submit)
  8. Submission           — explicit --submit flag only

Requirements:
  pip install pydantic                  # required for structured extraction
  pip install anthropic instructor      # for Instructor-based extraction (recommended)
  pip install python-dotenv             # to load .env.local automatically

  Without anthropic + instructor, the script falls back to the Claude CLI
  (must be installed and authenticated separately).

Observability:
  Langfuse tracing is enabled when LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY are set.
  Without them, tracing is silently disabled — no change in behavior.

Usage:
    python3 scripts/harvest_proposals.py                         # recent Claude Code sessions
    python3 scripts/harvest_proposals.py --dry-run               # print staged, don't write
    python3 scripts/harvest_proposals.py --submit                # stage + POST to /api/decisions
    python3 scripts/harvest_proposals.py --full-history          # ignore recency filter
    python3 scripts/harvest_proposals.py --since 7d              # custom lookback (hours or days)
    python3 scripts/harvest_proposals.py --session /path/to/session.jsonl

    # Any agent tool — pass a text file or pipe stdin:
    python3 scripts/harvest_proposals.py --input session.txt --source cursor
    python3 scripts/harvest_proposals.py --input messages.json --source openai-assistants
    cat session.txt | python3 scripts/harvest_proposals.py --input - --source langgraph

    # Supported --input formats:
    #   Labeled turns:  "User: ...\nAssistant: ..." (also Human/Claude/AI)
    #   Messages JSON:  [{"role": "user", "content": "..."}, ...]
    #   Raw text:       treated as a single block for extraction

Cron (every 4 hours, stage only):
    0 */4 * * * cd /path/to/govinuity && python3 scripts/harvest_proposals.py >> scripts/harvest.log 2>&1
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

# ── Load .env.local before anything else ─────────────────────────────────────

_REPO_DIR = Path(__file__).parent.parent.resolve()
_env_local = _REPO_DIR / ".env.local"
if _env_local.exists():
    try:
        from dotenv import load_dotenv
        load_dotenv(_env_local, override=False)
    except ImportError:
        pass  # dotenv not installed — silently skip


# ── Config ────────────────────────────────────────────────────────────────────

DRY_RUN       = "--dry-run" in sys.argv
SUBMIT        = "--submit" in sys.argv
FULL_HISTORY  = "--full-history" in sys.argv

GOVINUITY_URL       = os.environ.get("GOVINUITY_URL", "http://localhost:3000")
CLAUDE_BIN          = os.environ.get("CLAUDE_BIN", str(Path.home() / ".local" / "bin" / "claude"))
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
WATERMARK_FILE      = Path.home() / ".claude" / "proposal_harvest_watermark.json"
META_DIR            = Path(os.environ.get("GOVINUITY_META_DIR", Path.home() / ".govinuity" / "data"))
DECISIONS_PATH      = META_DIR / "decisions.jsonl"
ANTHROPIC_API_KEY   = os.environ.get("ANTHROPIC_API_KEY", "")

STAGE_FILE = _REPO_DIR / "scripts" / ".harvest_staged.json"

DEFAULT_LOOKBACK_HOURS = 48
MIN_TURN_LENGTH        = 30
CHUNK_SIZE             = 60

# Model used for Instructor-based extraction
EXTRACTION_MODEL = os.environ.get("HARVEST_MODEL", "claude-haiku-4-5-20251001")

# Only these canonical authority classes survive consolidation and reach the staging file.
ALLOWED_CLASSES = {
    "architectural_decision",    # shapes system structure or major technical direction
    "durable_workflow_rule",     # governs how work is done across sessions
    "scoped_exception",          # specific rule for a bounded area; only relevant in that scope
    "durable_constraint",        # operational/config constraint that must persist
}


# ── Langfuse tracing (optional, no-ops when not configured) ───────────────────

_LANGFUSE_ENABLED = bool(
    os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")
)

if _LANGFUSE_ENABLED:
    try:
        from langfuse import observe, get_client as _lf_get_client
        _lf = _lf_get_client()
    except Exception:
        _LANGFUSE_ENABLED = False

if not _LANGFUSE_ENABLED:
    _lf = None
    def observe(func=None, *, name=None, as_type=None, capture_input=True, capture_output=True, **kw):
        """No-op observe decorator when Langfuse is not configured."""
        if func is not None:
            return func
        return lambda f: f


# ── Pydantic models for structured extraction (Instructor) ────────────────────

try:
    from pydantic import BaseModel, Field

    class CandidateProposal(BaseModel):
        title: str = Field(description="Max 80 chars, specific and unambiguous")
        body: str = Field(description="1-3 sentence clear statement of the decision")
        rationale: str = Field(description="Why this must be remembered across sessions")
        summary_for_human: str = Field(description="One-liner a reviewer understands without context")
        why_surfaced: str = Field(description="What in the conversation triggered this")
        reversibility: Literal["low", "medium", "high"]
        possible_conflicts: list[str] = Field(default_factory=list)
        scope: Literal["global", "project", "app"] = "global"
        tags: list[str] = Field(default_factory=list)
        apparent_settled: bool = Field(description="Was this explicitly agreed upon, not just mentioned?")
        proposal_class: Literal[
            "architectural_decision",
            "durable_workflow_rule",
            "scoped_exception",
            "durable_constraint",
            "personal_profile",
            "local_exception",
            "exploratory_direction",
            "ephemeral_note",
        ]

    class ExtractionResult(BaseModel):
        candidates: list[CandidateProposal] = Field(default_factory=list)

    class CorrectionSignal(BaseModel):
        annotation_type: Literal[
            "continuity_correction_required",
            "context_restatement_required",
            "approved_decision_not_followed",
            "stale_leakage_detected",
            "approved_decision_followed",
        ]
        evidence: str = Field(description="Brief quote or summary from the transcript that triggered this signal (max 200 chars)")
        decision_hint: str = Field(default="", description="Title or topic of the specific decision this relates to, if identifiable")

    class CorrectionResult(BaseModel):
        signals: list[CorrectionSignal] = Field(default_factory=list)

    _PYDANTIC_AVAILABLE = True
except ImportError:
    _PYDANTIC_AVAILABLE = False


# ── Helpers ───────────────────────────────────────────────────────────────────

def log(msg: str):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


def parse_since_arg() -> float:
    for i, arg in enumerate(sys.argv):
        if arg == "--since" and i + 1 < len(sys.argv):
            val = sys.argv[i + 1]
            if val.endswith("h"):
                return float(val[:-1])
            if val.endswith("d"):
                return float(val[:-1]) * 24
    return DEFAULT_LOOKBACK_HOURS


def explicit_session() -> Optional[Path]:
    for i, arg in enumerate(sys.argv):
        if arg == "--session" and i + 1 < len(sys.argv):
            return Path(sys.argv[i + 1])
    return None


def explicit_input() -> Optional[Path]:
    """Return path from --input flag. Returns None if flag absent or value is '-' (stdin)."""
    for i, arg in enumerate(sys.argv):
        if arg == "--input" and i + 1 < len(sys.argv):
            val = sys.argv[i + 1]
            return None if val == "-" else Path(val)
    return None


def reading_stdin() -> bool:
    """True when --input - is given."""
    try:
        idx = sys.argv.index("--input")
        return idx + 1 < len(sys.argv) and sys.argv[idx + 1] == "-"
    except ValueError:
        return False


def explicit_source() -> str:
    """Return --source label, default 'text'."""
    for i, arg in enumerate(sys.argv):
        if arg == "--source" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return "text"


def load_watermark() -> dict:
    if WATERMARK_FILE.exists():
        try:
            return json.loads(WATERMARK_FILE.read_text())
        except Exception:
            pass
    return {}


def save_watermark(wm: dict):
    WATERMARK_FILE.write_text(json.dumps(wm, indent=2))


def extract_text_from_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(p for p in parts if p.strip())
    return ""


def classify_source_trust(turns: list[dict]) -> str:
    """Estimate trust level for a chunk based on its content."""
    texts = " ".join(t["text"] for t in turns)

    high_markers = [
        "here's what was built", "phase", "is done", "zero errors",
        "clean.", "all pass", "implemented", "what was built",
    ]
    if any(m in texts.lower() for m in high_markers):
        return "high"

    settle_markers = ["sounds good", "let's do", "agreed", "confirmed", "correct"]
    if any(m in texts.lower() for m in settle_markers):
        return "medium"

    return "medium"


def jaccard(a: str, b: str) -> float:
    sa = set(re.sub(r"[^\w\s]", "", a.lower()).split())
    sb = set(re.sub(r"[^\w\s]", "", b.lower()).split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def load_existing_titles() -> list[str]:
    """Return titles of existing decisions (any status) for dedup."""
    if not DECISIONS_PATH.exists():
        return []
    titles = []
    for line in DECISIONS_PATH.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            t = entry.get("title") or (entry.get("body", "") or "")[:80]
            if t:
                titles.append(t)
        except Exception:
            pass
    return titles


# ── Turn loading ──────────────────────────────────────────────────────────────

def load_session_turns(path: Path, after_ts: Optional[str]) -> list[dict]:
    turns = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                t   = obj.get("type")
                ts  = obj.get("timestamp", "")

                if after_ts and ts <= after_ts:
                    continue
                if t not in ("user", "assistant"):
                    continue

                msg     = obj.get("message", {})
                content = msg.get("content", "")
                text    = extract_text_from_content(content)

                if len(text.strip()) < MIN_TURN_LENGTH:
                    continue

                if t == "assistant":
                    clean = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.DOTALL).strip()
                    if len(clean) < MIN_TURN_LENGTH:
                        continue
                    text = clean

                if len(text.strip()) < MIN_TURN_LENGTH:
                    continue

                turns.append({
                    "role": t,
                    "text": text[:2000],
                    "ts":   ts,
                })
    except Exception as e:
        log(f"  Warning: could not read {path}: {e}")
    return turns


def chunk_turns(turns: list[dict]) -> list[list[dict]]:
    return [turns[i:i + CHUNK_SIZE] for i in range(0, len(turns), CHUNK_SIZE)]


# ── Extraction prompt ─────────────────────────────────────────────────────────

EXTRACT_PROMPT = """You are a continuity-extraction assistant for a governed decision memory system.

Read this conversation excerpt (chunk {idx}/{total}, source_trust={trust}).

Extract decisions or rules that are DURABLE CONTINUITY OBJECTS — things that should govern future work across sessions, not just the current task.

STRICT EXCLUSIONS — do NOT extract:
- Implementation details of tools, scripts, or code being built in this conversation (e.g. "the script uses stdin", "flag X does Y")
- Debugging steps, workarounds, or fixes that were applied once
- Decisions about how to run the current task (e.g. "let's test this first")
- Anything that only matters within this conversation
- Personal profile statements (e.g. "Alex is a strategist") unless explicitly marked as durable
- Exploratory directions that are still in flux

A good continuity object answers: "Would a future agent or session need to know this to do their work correctly?"

For each candidate, return:
- title: max 80 chars, specific and unambiguous
- body: 1-3 sentence clear statement of the decision
- rationale: why this must be remembered across sessions (not just "we decided this")
- summary_for_human: one-liner a reviewer understands without context
- why_surfaced: what in the conversation triggered this
- reversibility: low | medium | high
- possible_conflicts: list of short conflict descriptions (empty if none)
- scope: global | project | app
- tags: list of relevant tags (empty if none)
- apparent_settled: true if explicitly agreed upon, false if still exploratory
- proposal_class: one of:
    architectural_decision  — shapes system structure or major technical direction
    durable_workflow_rule   — governs how work is done across sessions
    scoped_exception        — specific rule for a bounded area
    durable_constraint      — operational/config constraint that must persist
    personal_profile        — (will be filtered) facts about the user, not the system
    local_exception         — (will be filtered) one-off exception, not durable
    exploratory_direction   — (will be filtered) direction that did not settle
    ephemeral_note          — (will be filtered) temporary, context-specific

If nothing qualifies, return an empty candidates list.

--- EXCERPT ---

{turns}"""


# ── Stage 1a: Extraction via Instructor + Anthropic SDK ───────────────────────

@observe(name="extract-chunk-instructor", as_type="generation", capture_input=False)
def extract_chunk_candidates_instructor(
    chunk: list[dict], idx: int, total: int
) -> list[dict]:
    """Structured extraction using Instructor + Anthropic SDK."""
    import instructor
    import anthropic

    trust = classify_source_trust(chunk)
    turns_text = "\n\n".join(
        f"[{t['ts'][:16]}] {'User' if t['role']=='user' else 'Claude'}: {t['text']}"
        for t in chunk
    )
    prompt = EXTRACT_PROMPT.format(idx=idx, total=total, trust=trust, turns=turns_text)

    try:
        client = instructor.from_anthropic(anthropic.Anthropic())
        result: ExtractionResult = client.messages.create(
            model=EXTRACTION_MODEL,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
            response_model=ExtractionResult,
        )
        position = (idx - 1) / max(total - 1, 1)
        candidates = []
        for c in result.candidates:
            d = c.model_dump()
            d["chunk_idx"] = idx
            d["chunk_position"] = round(position, 2)
            d["source_trust"] = trust
            d["extraction_method"] = "instructor"
            candidates.append(d)

        if _LANGFUSE_ENABLED:
            try:
                _lf.update_current_span(
                    output={"candidate_count": len(candidates)},
                    metadata={"chunk_idx": idx, "total_chunks": total, "trust": trust},
                )
            except Exception:
                pass

        return candidates

    except Exception as e:
        log(f"    Chunk {idx}: Instructor extraction error — {e}")
        return []


# ── Stage 1b: Extraction via subprocess Claude CLI (fallback) ─────────────────

def extract_chunk_candidates_subprocess(
    chunk: list[dict], idx: int, total: int
) -> list[dict]:
    """Fallback extraction via subprocess Claude CLI (no API key required)."""
    trust = classify_source_trust(chunk)
    turns_text = "\n\n".join(
        f"[{t['ts'][:16]}] {'User' if t['role']=='user' else 'Claude'}: {t['text']}"
        for t in chunk
    )
    prompt = EXTRACT_PROMPT.format(idx=idx, total=total, trust=trust, turns=turns_text)

    # Append JSON-only instruction for the CLI path (no schema enforcement)
    prompt += "\n\nReturn a JSON object with a single key 'candidates' containing an array of candidate objects. Return ONLY valid JSON. No prose, no markdown fences."

    try:
        result = subprocess.run(
            [CLAUDE_BIN, "--print", "--output-format=text"],
            input=prompt, capture_output=True, text=True, timeout=120,
        )
        raw = (result.stdout or result.stderr or "").strip()
        if not raw:
            return []
        raw = re.sub(r"^```(?:json)?\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
        # Try object first ({"candidates": [...]})
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            parsed = json.loads(match.group(0))
            raw_candidates = parsed.get("candidates", [])
        else:
            # Fall back to bare array
            match = re.search(r"(\[.*\])", raw, re.DOTALL)
            raw_candidates = json.loads(match.group(1)) if match else []

        position = (idx - 1) / max(total - 1, 1)
        for c in raw_candidates:
            c["chunk_idx"]      = idx
            c["chunk_position"] = round(position, 2)
            c["source_trust"]   = trust
            c["extraction_method"] = "subprocess"
        return raw_candidates

    except json.JSONDecodeError as e:
        log(f"    Chunk {idx}: JSON parse error — {e}")
        return []
    except Exception as e:
        log(f"    Chunk {idx}: extraction error — {e}")
        return []


def extract_chunk_candidates(chunk: list[dict], idx: int, total: int) -> list[dict]:
    """Route to Instructor or subprocess depending on API key availability."""
    if ANTHROPIC_API_KEY and _PYDANTIC_AVAILABLE:
        return extract_chunk_candidates_instructor(chunk, idx, total)
    return extract_chunk_candidates_subprocess(chunk, idx, total)


# ── Correction detection — one pass per session ───────────────────────────────

# Sample up to this many turns for correction detection (avoids token bloat)
CORRECTION_SAMPLE_TURNS = 120

CORRECTION_PROMPT = """You are reviewing a Claude Code session transcript to detect continuity outcome signals.

A continuity system may have injected ratified governing decisions into this session's context. Your job is to detect evidence of how well continuity worked — both problems and positive signals.

Detect the following signal types only when there is clear evidence:

- continuity_correction_required: The agent made an error that required explicit correction. Look for: user saying "no", "that's wrong", "stop doing that", "I already told you not to", clear mid-session corrections.

- context_restatement_required: The user had to re-explain something that should have been carried forward from prior sessions. Look for: "as I mentioned before", "I already told you", "remember we decided", having to repeat prior constraints or decisions.

- approved_decision_not_followed: A governing rule or constraint that should have been respected was ignored. Look for: agent violating a pattern the user previously established, doing something the user previously said not to do.

- stale_leakage_detected: Outdated or superseded information caused confusion or incorrect behavior. Look for: agent acting on old assumptions, referencing something that was explicitly changed in a prior session.

- approved_decision_followed: Clear positive signal — a governing rule was correctly applied without being re-stated. Look for: agent correctly applying constraints or patterns unprompted, continuity clearly working.

Return only signals with clear evidence. If the transcript shows no continuity-relevant events, return an empty signals list.

--- SESSION TRANSCRIPT ---

{turns}"""


def detect_corrections_instructor(turns: list[dict]) -> list[dict]:
    """Detect correction signals using Instructor + Anthropic SDK."""
    import instructor
    import anthropic

    sample = turns[-CORRECTION_SAMPLE_TURNS:]
    turns_text = "\n\n".join(
        f"[{t['ts'][:16]}] {'User' if t['role']=='user' else 'Claude'}: {t['text'][:1000]}"
        for t in sample
    )
    prompt = CORRECTION_PROMPT.format(turns=turns_text)

    try:
        client = instructor.from_anthropic(anthropic.Anthropic())
        result: CorrectionResult = client.messages.create(
            model=EXTRACTION_MODEL,
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
            response_model=CorrectionResult,
        )
        return [s.model_dump() for s in result.signals]
    except Exception as e:
        log(f"  Correction detection error (instructor): {e}")
        return []


def detect_corrections_subprocess(turns: list[dict]) -> list[dict]:
    """Detect correction signals via subprocess Claude CLI (fallback)."""
    sample = turns[-CORRECTION_SAMPLE_TURNS:]
    turns_text = "\n\n".join(
        f"[{t['ts'][:16]}] {'User' if t['role']=='user' else 'Claude'}: {t['text'][:1000]}"
        for t in sample
    )
    prompt = CORRECTION_PROMPT.format(turns=turns_text)
    prompt += "\n\nReturn a JSON object with a single key 'signals' containing an array of signal objects. Return ONLY valid JSON. No prose, no markdown fences."

    try:
        result = subprocess.run(
            [CLAUDE_BIN, "--print", "--output-format=text"],
            input=prompt, capture_output=True, text=True, timeout=120,
        )
        raw = (result.stdout or result.stderr or "").strip()
        if not raw:
            return []
        raw = re.sub(r"^```(?:json)?\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        if match:
            parsed = json.loads(match.group(0))
            return parsed.get("signals", [])
        return []
    except Exception as e:
        log(f"  Correction detection error (subprocess): {e}")
        return []


def detect_corrections(turns: list[dict]) -> list[dict]:
    """Route to Instructor or subprocess for correction detection."""
    if ANTHROPIC_API_KEY and _PYDANTIC_AVAILABLE:
        return detect_corrections_instructor(turns)
    return detect_corrections_subprocess(turns)


# ── Run matching ──────────────────────────────────────────────────────────────

def find_run_for_session(first_ts: str, last_ts: str) -> Optional[str]:
    """
    Find the run_id of the continuity run most likely associated with this session.
    Runs are logged when /api/memory is called at session start, so we look for
    a run whose ts falls within 2 hours before the first session turn.
    """
    import urllib.request as ur
    from datetime import timedelta
    try:
        with ur.urlopen(f"{GOVINUITY_URL}/api/runs?limit=100", timeout=10) as resp:
            data = json.loads(resp.read())
        runs = data.get("runs", [])
        if not runs:
            return None

        first_dt = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
        window_start = (first_dt - timedelta(hours=2)).isoformat()

        candidates = [
            r for r in runs
            if window_start <= r.get("ts", "") <= last_ts
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda r: r.get("ts", ""), reverse=True)
        return candidates[0]["run_id"]
    except Exception as e:
        log(f"  Run matching failed: {e}")
        return None


# ── Annotation submission ─────────────────────────────────────────────────────

def submit_annotations(run_id: str, signals: list[dict]) -> int:
    """POST correction signals as run annotations to /api/run-annotations."""
    import urllib.request as ur
    submitted = 0
    for s in signals:
        annotation_type = s.get("annotation_type", "")
        if not annotation_type:
            continue
        entry = {
            "run_id":          run_id,
            "annotation_type": annotation_type,
            "value":           True,
            "note":            s.get("evidence", "")[:500] or None,
            "annotated_by":    "harvest",
        }
        decision_hint = s.get("decision_hint", "").strip()
        if decision_hint:
            entry["note"] = f"{decision_hint}: {entry['note'] or ''}".strip()
        try:
            payload = json.dumps(entry).encode()
            req = ur.Request(
                f"{GOVINUITY_URL}/api/run-annotations",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with ur.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read())
                if result.get("ok"):
                    submitted += 1
                    log(f"    + annotated [{annotation_type}]: {(entry.get('note') or '')[:60]}")
        except Exception as e:
            log(f"    Annotation submit error: {e}")
    return submitted


# ── Stage 2: Algorithmic consolidation (no Claude call) ──────────────────────

def consolidate_candidates(all_candidates: list[dict]) -> list[dict]:
    """
    Consolidate candidates without a Claude call:
    1. Drop non-settled and suppressed classes
    2. Group near-duplicates by title Jaccard similarity — keep latest (highest chunk_position)
    3. Drop low-trust unsettled candidates
    """
    if not all_candidates:
        return []

    filtered = []
    for c in all_candidates:
        cls     = c.get("proposal_class", "")
        settled = c.get("apparent_settled", True)
        trust   = c.get("source_trust", "medium")

        if cls not in ALLOWED_CLASSES:
            continue
        if not settled and trust == "low":
            continue
        filtered.append(c)

    if not filtered:
        return []

    sorted_by_pos = sorted(filtered, key=lambda c: c.get("chunk_position", 0.0), reverse=True)
    kept: list[dict] = []
    for candidate in sorted_by_pos:
        title = candidate.get("title", "")
        duplicate = any(jaccard(title, k.get("title", "")) >= 0.45 for k in kept)
        if not duplicate:
            kept.append(candidate)

    log(f"  Consolidation: {len(all_candidates)} raw → {len(filtered)} after class/settled filter → {len(kept)} after temporal dedup")
    return kept


# ── Stage 3: Deduplication against existing decisions ─────────────────────────

def dedupe_against_existing(candidates: list[dict], existing_titles: list[str]) -> list[dict]:
    kept = []
    for c in candidates:
        title = c.get("title", "")
        body  = c.get("body", "")
        probe = title or body[:80]
        best_sim = max((jaccard(probe, ex) for ex in existing_titles), default=0.0)
        if best_sim >= 0.55:
            log(f"    Dedup skip (sim={best_sim:.2f}): {probe[:60]}")
        else:
            kept.append(c)
    return kept


def dedupe_within_batch(candidates: list[dict]) -> list[dict]:
    kept = []
    for c in candidates:
        probe = c.get("title") or c.get("body", "")[:80]
        duplicate = False
        for k in kept:
            other = k.get("title") or k.get("body", "")[:80]
            if jaccard(probe, other) >= 0.55:
                duplicate = True
                break
        if not duplicate:
            kept.append(c)
    return kept


# ── Stage 4: Staging ──────────────────────────────────────────────────────────

def write_staged(candidates: list[dict], session_meta: list[dict], correction_signals: Optional[list[dict]] = None):
    payload = {
        "harvested_at": datetime.now(timezone.utc).isoformat(),
        "candidate_count": len(candidates),
        "sessions": session_meta,
        "candidates": candidates,
        "correction_signals": correction_signals or [],
    }
    STAGE_FILE.write_text(json.dumps(payload, indent=2))
    signal_count = len(correction_signals or [])
    log(f"  Staged {len(candidates)} candidate(s), {signal_count} correction signal(s) → {STAGE_FILE}")


def print_staged(candidates: list[dict], correction_signals: Optional[list[dict]] = None):
    for c in candidates:
        print(f"\n  [{c.get('proposal_class','?')}] {c.get('title','?')}")
        print(f"    {c.get('summary_for_human','')}")
        print(f"    reversibility={c.get('reversibility','?')} scope={c.get('scope','?')}")
        method = c.get("extraction_method", "?")
        print(f"    extraction={method}")

    if correction_signals:
        print(f"\n  --- Correction signals ({len(correction_signals)}) ---")
        for s in correction_signals:
            atype = s.get("annotation_type", "?")
            hint  = s.get("decision_hint", "")
            ev    = (s.get("evidence") or "")[:100]
            label = f"{hint}: {ev}" if hint else ev
            print(f"  [{atype}] {label}")


# ── Stage 5: Submission ───────────────────────────────────────────────────────

def submit_candidates(candidates: list[dict]) -> int:
    import urllib.request as ur
    submitted = 0
    for c in candidates:
        entry = {
            "status":            "proposed",
            "body":              c.get("body", ""),
            "title":             c.get("title", ""),
            "rationale":         c.get("rationale", ""),
            "summary_for_human": c.get("summary_for_human", ""),
            "why_surfaced":      c.get("why_surfaced", ""),
            "reversibility":     c.get("reversibility", "medium"),
            "possible_conflicts": c.get("possible_conflicts", []),
            "scope":             c.get("scope", "global"),
            "tags":              c.get("tags", []),
            "source":            "harvest",
        }
        if not entry["body"]:
            continue
        try:
            payload = json.dumps(entry).encode()
            req = ur.Request(
                f"{GOVINUITY_URL}/api/decisions",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with ur.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read())
                if result.get("ok"):
                    submitted += 1
                    log(f"    + submitted: {entry['title'][:60]}")
        except Exception as e:
            log(f"    Submit error: {e}")
    return submitted


# ── Text input loader (non-Claude sources) ───────────────────────────────────

def load_text_turns(text: str) -> list[dict]:
    """
    Convert plain text to the {role, text, ts} format expected by the extraction pipeline.

    Handles three input shapes:
      1. OpenAI / Anthropic messages JSON — list of {"role": ..., "content": ...} objects
      2. Labeled turns — lines starting with "User:", "Human:", "Assistant:", "Claude:", "AI:"
      3. Raw text — treated as a single block attributed to "user"

    Timestamps are synthetic (current time minus turn index in seconds) since plain
    text sources do not carry session timestamps.
    """
    from datetime import timedelta

    stripped = text.strip()
    base_ts = datetime.now(timezone.utc)

    # ── 1. JSON message array ─────────────────────────────────────────────────
    if stripped.startswith("["):
        try:
            messages = json.loads(stripped)
            if isinstance(messages, list) and all(isinstance(m, dict) and "role" in m for m in messages):
                turns = []
                for i, m in enumerate(messages):
                    content = m.get("content", "")
                    if isinstance(content, list):
                        content = "\n".join(
                            b.get("text", "") for b in content
                            if isinstance(b, dict) and b.get("type") == "text"
                        )
                    role = m.get("role", "user")
                    if role not in ("user", "assistant"):
                        continue
                    content = str(content).strip()
                    if len(content) < MIN_TURN_LENGTH:
                        continue
                    fake_ts = (base_ts - timedelta(seconds=(len(messages) - i))).isoformat()
                    turns.append({"role": role, "text": content[:2000], "ts": fake_ts})
                if turns:
                    log(f"  Detected OpenAI/Anthropic messages JSON — {len(turns)} turns")
                    return turns
        except (json.JSONDecodeError, TypeError):
            pass

    # ── 2. Labeled turns ──────────────────────────────────────────────────────
    LABEL_RE = re.compile(
        r"^(User|Human|Assistant|Claude|AI)\s*:\s*",
        re.IGNORECASE | re.MULTILINE,
    )
    matches = list(LABEL_RE.finditer(text))
    if matches:
        turns = []
        for i, match in enumerate(matches):
            role_str = match.group(1).lower()
            role = "user" if role_str in ("user", "human") else "assistant"
            start = match.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            content = text[start:end].strip()
            if len(content) < MIN_TURN_LENGTH:
                continue
            fake_ts = (base_ts - timedelta(seconds=(len(matches) - i))).isoformat()
            turns.append({"role": role, "text": content[:2000], "ts": fake_ts})
        if turns:
            log(f"  Detected labeled turns — {len(turns)} turns")
            return turns

    # ── 3. Raw text ───────────────────────────────────────────────────────────
    if len(stripped) >= MIN_TURN_LENGTH:
        log("  No turn structure detected — treating as single block")
        return [{"role": "user", "text": stripped[:2000], "ts": base_ts.isoformat()}]

    return []


def harvest_text_input(text: str, source_label: str) -> tuple:
    """
    Run the extraction pipeline over plain text from a non-Claude source.
    Returns (raw_count, final_count, candidates, signals).
    No watermark tracking — text inputs are treated as one-shot.
    """
    turns = load_text_turns(text)
    if not turns:
        log("  No usable turns found in input.")
        return 0, 0, [], []

    chunks = chunk_turns(turns)
    log(f"  {source_label}: {len(turns)} turns → {len(chunks)} chunk(s)")

    all_raw = []
    for i, chunk in enumerate(chunks, 1):
        raw = extract_chunk_candidates(chunk, i, len(chunks))
        log(f"    Chunk {i}/{len(chunks)}: {len(raw)} raw candidate(s) (trust={classify_source_trust(chunk)})")
        all_raw.extend(raw)

    consolidated = consolidate_candidates(all_raw) if all_raw else []

    log("  Detecting correction signals…")
    signals = detect_corrections(turns)
    log(f"  {len(signals)} correction signal(s) detected")

    return len(all_raw), len(consolidated), consolidated, signals


# ── Session harvester ─────────────────────────────────────────────────────────

@observe(name="harvest-session", as_type="span", capture_input=False)
def harvest_session(path: Path, watermark: dict, since_ts: Optional[str] = None) -> tuple:
    """
    Returns (raw_candidate_count, final_candidate_count, first_ts, last_ts, candidates, signals).
    since_ts: ISO timestamp — skip turns older than this (used when no watermark exists).
    signals: correction/outcome signals detected from the session transcript.
    """
    key      = str(path)
    after_ts = None if FULL_HISTORY else (watermark.get(key) or since_ts)

    turns = load_session_turns(path, after_ts)
    if not turns:
        return 0, 0, None, watermark.get(key), [], []

    first_ts = turns[0]["ts"]
    last_ts  = turns[-1]["ts"]
    chunks   = chunk_turns(turns)
    log(f"  {path.name}: {len(turns)} turns → {len(chunks)} chunk(s) (after {after_ts or 'beginning'})")

    all_raw = []
    for i, chunk in enumerate(chunks, 1):
        raw = extract_chunk_candidates(chunk, i, len(chunks))
        log(f"    Chunk {i}/{len(chunks)}: {len(raw)} raw candidate(s) (trust={classify_source_trust(chunk)})")
        all_raw.extend(raw)

    consolidated = consolidate_candidates(all_raw) if all_raw else []

    # Correction detection — one pass over the full session
    log(f"  Detecting correction signals…")
    signals = detect_corrections(turns)
    log(f"  {len(signals)} correction signal(s) detected")

    if _LANGFUSE_ENABLED:
        try:
            _lf.update_current_span(
                output={"raw": len(all_raw), "consolidated": len(consolidated), "signals": len(signals)},
                metadata={"session": path.name, "turns": len(turns), "chunks": len(chunks)},
            )
        except Exception:
            pass

    return len(all_raw), len(consolidated), first_ts, last_ts, consolidated, signals


# ── Main ──────────────────────────────────────────────────────────────────────

def find_session_files(lookback_hours: float) -> list[Path]:
    cutoff = time.time() - lookback_hours * 3600
    files  = []
    if not CLAUDE_PROJECTS_DIR.exists():
        return files
    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        for f in project_dir.glob("*.jsonl"):
            if f.stat().st_mtime >= cutoff:
                files.append(f)
    return sorted(files, key=lambda f: f.stat().st_mtime)


@observe(name="harvest-run", as_type="span", capture_input=False)
def main():
    lookback = DEFAULT_LOOKBACK_HOURS if not FULL_HISTORY else float("inf")
    if not FULL_HISTORY:
        lookback = parse_since_arg()

    extraction_mode = "instructor" if (ANTHROPIC_API_KEY and _PYDANTIC_AVAILABLE) else "subprocess"
    log(
        f"harvest starting — dry_run={DRY_RUN} submit={SUBMIT} "
        f"full_history={FULL_HISTORY} lookback={'∞' if FULL_HISTORY else f'{lookback}h'} "
        f"extraction={extraction_mode} langfuse={_LANGFUSE_ENABLED}"
    )

    watermark = load_watermark()
    existing_titles = load_existing_titles()
    log(f"Loaded {len(existing_titles)} existing decision titles for dedup")

    since_ts: Optional[str] = None
    if not FULL_HISTORY:
        from datetime import timedelta
        cutoff_dt = datetime.now(timezone.utc) - timedelta(hours=lookback)
        since_ts  = cutoff_dt.isoformat()

    # ── Text input mode (--input) — any non-Claude source ────────────────────
    input_path = explicit_input()
    stdin_mode = reading_stdin()

    if input_path is not None or stdin_mode:
        source_label = explicit_source()
        if stdin_mode:
            log("Reading from stdin…")
            text = sys.stdin.read()
        else:
            if not input_path.exists():
                log(f"Error: input file not found: {input_path}")
                sys.exit(1)
            log(f"Reading from {input_path} (source={source_label})…")
            text = input_path.read_text(encoding="utf-8", errors="replace")

        raw_count, final_count, candidates, signals = harvest_text_input(text, source_label)

        all_candidates = dedupe_within_batch(candidates)
        all_candidates = dedupe_against_existing(all_candidates, existing_titles)
        all_signals = signals

        log(f"\nFinal candidate count: {len(all_candidates)}, correction signals: {len(all_signals)}")

        if DRY_RUN:
            print_staged(all_candidates, all_signals)
            log("Dry-run complete — nothing written or submitted.")
            return

        if not all_candidates and not all_signals:
            log("No candidates or correction signals found.")
            return

        source_meta = [{"source": source_label, "input": str(input_path or "stdin")}]
        write_staged(all_candidates, source_meta, all_signals)

        if SUBMIT:
            if all_candidates:
                log("Submitting staged candidates…")
                submitted = submit_candidates(all_candidates)
                log(f"Submitted {submitted}/{len(all_candidates)} candidates.")
                if submitted == len(all_candidates):
                    STAGE_FILE.unlink(missing_ok=True)
        else:
            log(f"Staged. Review at: {STAGE_FILE}")
            log("To submit: python3 scripts/harvest_proposals.py --submit")
        return

    # ── Claude Code session file mode (default) ───────────────────────────────
    explicit = explicit_session()
    if explicit:
        session_files = [explicit]
    elif FULL_HISTORY:
        session_files = find_session_files(float("inf"))
    else:
        session_files = find_session_files(lookback)

    if not session_files:
        log("No session files found.")
        return

    log(f"Found {len(session_files)} session file(s)" + (f" (turns after {since_ts[:16]})" if since_ts else ""))

    all_candidates  = []
    session_meta    = []
    session_signals = []   # list of (first_ts, last_ts, signals) per session
    new_watermark   = dict(watermark)

    for path in session_files:
        raw_count, final_count, first_ts, last_ts, candidates, signals = harvest_session(path, watermark, since_ts)

        if last_ts and not DRY_RUN:
            new_watermark[str(path)] = last_ts

        if candidates:
            all_candidates.extend(candidates)
            session_meta.append({"path": str(path), "first_ts": first_ts, "last_ts": last_ts, "count": final_count})

        if signals and first_ts and last_ts:
            session_signals.append({"first_ts": first_ts, "last_ts": last_ts, "signals": signals})

    before_dedup = len(all_candidates)
    all_candidates = dedupe_within_batch(all_candidates)
    log(f"Batch dedup: {before_dedup} → {len(all_candidates)}")

    before_existing = len(all_candidates)
    all_candidates = dedupe_against_existing(all_candidates, existing_titles)
    log(f"Existing dedup: {before_existing} → {len(all_candidates)}")

    all_signals = [s for ss in session_signals for s in ss["signals"]]
    log(f"\nFinal candidate count: {len(all_candidates)}, correction signals: {len(all_signals)}")

    if _LANGFUSE_ENABLED:
        try:
            _lf.update_current_span(
                output={"final_candidates": len(all_candidates), "correction_signals": len(all_signals)},
                metadata={"sessions": len(session_files), "extraction_mode": extraction_mode},
            )
        except Exception:
            pass

    if DRY_RUN:
        print_staged(all_candidates, all_signals)
        log("Dry-run complete — nothing written or submitted.")
        return

    if not all_candidates and not all_signals:
        log("No candidates or correction signals to stage.")
        if not FULL_HISTORY:
            save_watermark(new_watermark)
        return

    write_staged(all_candidates, session_meta, all_signals)
    save_watermark(new_watermark)

    if SUBMIT:
        if all_candidates:
            log("Submitting staged candidates…")
            submitted = submit_candidates(all_candidates)
            log(f"Submitted {submitted}/{len(all_candidates)} candidates.")
            if submitted == len(all_candidates):
                STAGE_FILE.unlink(missing_ok=True)

        if session_signals:
            log("Submitting correction annotations…")
            total_annotations = 0
            for ss in session_signals:
                run_id = find_run_for_session(ss["first_ts"], ss["last_ts"])
                if run_id:
                    n = submit_annotations(run_id, ss["signals"])
                    total_annotations += n
                else:
                    log(f"  No matching run found for session ({ss['first_ts'][:16]} → {ss['last_ts'][:16]}) — signals skipped")
            log(f"Submitted {total_annotations} annotation(s) across {len(session_signals)} session(s).")
    else:
        log(f"Staged. Review at: {STAGE_FILE}")
        log("To submit: python3 scripts/harvest_proposals.py --submit --dry-run  (preview)")
        log("           python3 scripts/harvest_proposals.py --submit")

    if _LANGFUSE_ENABLED:
        try:
            _lf.flush()
        except Exception:
            pass


if __name__ == "__main__":
    main()
