# Semantic backfill

Use this to normalize legacy JSONL records so Govinuity relies less on fallback inference.

## Command

Dry run:

```bash
npm run semantic:backfill
```

Write normalized files:

```bash
npm run semantic:backfill -- --write
```

## What it currently normalizes

### feedback.jsonl
- fills `project` from context when missing

### review_queue.jsonl
- fills `project` from `original_entry.context` when missing
- adds compact fallback provenance with `sourceEntryId` + `derivedFrom[]` when missing

### decisions.jsonl
- fills `project` from context when missing
- adds compact provenance when missing
- uses `legacy-normalized` as `linkType` for backfilled legacy decisions

## Safety

- default mode is dry-run only
- write mode uses atomic temp-file + rename replacement
- reports unresolved contexts that still cannot be mapped to a project
- intended as a migration bridge, not as a substitute for better write-time semantics
