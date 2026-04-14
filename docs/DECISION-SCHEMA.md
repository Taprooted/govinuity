# Decision Schema

This document describes the decision data model as it exists in Govinuity. Every field listed here is enforced by the API or the injection layer. Where behavior is described, it derives from `lib/utils.ts`, `lib/decision-write.ts`, and `app/api/decisions/route.ts`.

---

## What makes something worth governing

A decision is worth governing when it meets three conditions:

1. **It would cost something to re-derive.** If a future agent session would have to spend effort figuring out the same thing again — through conversation, trial and error, or reading code — the decision should be persisted.

2. **It applies across more than one session.** One-off choices belong in commit messages or comments. Decisions that shape how work proceeds over time belong in Govinuity.

3. **It is stable enough to transfer.** If the answer changes every week, it shouldn't be injected as a governing instruction. If it holds across at least a few sessions, it should.

The governed continuity loop exists because agents are stateless across sessions. Decisions they arrived at — with you, or on your behalf — disappear unless explicitly persisted and re-injected. Naive persistence (storing everything) creates false authority: stale, low-confidence, or superseded decisions that an agent treats as current. Govinuity governs which decisions are in force at any point, using the fields below.

---

## Decision lifecycle

```
proposed → approved → (active injection)
         → deferred  → (held, not injected)
         → rejected  → (not injected, retained for history)

approved → superseded → (replaced by a newer decision)
approved → archived   → (manually retired)
```

The `under_review` status exists but is not currently assigned by the UI — it is reserved for future multi-step review workflows.

Only `approved` decisions with a non-superseded, non-expired, non-stale state are eligible for injection. All other statuses are excluded.

**API status values accepted on write:** `proposed`, `under_review`, `approved`, `rejected`, `deferred`

**`ratified_by` is required when status is `approved`.** The API rejects direct approval without a ratifier identity. This is intentional: it ensures every active decision has a named human in the ratification chain.

---

## `proposal_class`

Classifies what kind of governing object this is. Used during review to set expectations, and available as a filter on the Decisions page.

| Value | Meaning |
|---|---|
| `architectural_decision` | A structural choice about how the system is built — tech stack, data model, API contract. Hard to reverse. |
| `durable_workflow_rule` | A process rule that should apply consistently across sessions — naming conventions, review gates, commit norms. |
| `durable_constraint` | A hard limit: what must not be done, what requires approval before doing. |
| `scoped_exception` | A deliberate deviation from another rule, limited in scope or time. |

Legacy aliases (accepted, not recommended for new entries):

| Value | Maps to |
|---|---|
| `workflow_rule` | `durable_workflow_rule` |
| `scoped_implementation_rule` | `durable_workflow_rule` |
| `release_or_ops_config` | `durable_constraint` |

`proposal_class` is optional but strongly recommended. Unlabelled decisions are harder to govern over time.

---

## `scope` and `scope_ref`

Controls which injection contexts a decision applies to. At injection time, the scope is matched against the request context.

| `scope` | Matches when |
|---|---|
| `global` | Always matched. Injected into every session regardless of project or app. |
| `project` | `scope_ref` matches the `project` parameter on the injection request. |
| `app` | `scope_ref` matches the `app` parameter on the injection request. |
| `task` | `scope_ref` matches the `task` parameter. |
| `session` | `scope_ref` matches the `session` parameter. |
| `agent` | `scope_ref` matches the `agent` parameter. |

Scope matching is **fail-closed**: if a scoped decision's `scope_ref` does not match the request context, the decision is excluded with a machine-readable reason (e.g. `scope:project_mismatch`).

`scope_ref` should contain the slug or identifier of the target project, app, etc. For project-scoped decisions, it should match the project slug exactly.

Default: `global` for decisions submitted without a project; `project` for decisions submitted with a project.

---

## `transfer_tier`

Controls when a decision is eligible for automatic injection, independent of scope matching.

| Tier | Injection behavior |
|---|---|
| `always` | Injected whenever scope matches. Default for global decisions. |
| `by_project` | Injected only when a project context is provided on the request. Default for project-scoped decisions. |
| `explicit` | Only injected when the caller sets `explicit=true` on the request. Use for sensitive or high-specificity decisions. |
| `history_only` | Never injected into live context. Retained in the decision log for audit and reference only. |
| `re_ratify` | Never injected. Marks decisions that require fresh human ratification before returning to active status. |

Tiers `history_only` and `re_ratify` are hard exclusions — the injection layer does not evaluate scope or confidence for these decisions.

---

## `confidence`

A float between `0.0` and `1.0` representing how settled the decision is.

- Defaults to `0.8` on write.
- Hard injection threshold: **`< 0.6` is excluded** from injection with reason `confidence_below_threshold`.
- Values between `0.6` and `1.0` are all eligible — confidence is not a ranking signal, only a gate.

Intended use: set confidence lower for exploratory or provisional decisions, higher for well-tested ones. A decision ratified quickly or based on limited evidence should carry lower confidence than one that has survived multiple sessions.

---

## `review_after`

An ISO date string. When set, the decision is automatically excluded from injection once this date has elapsed, with exclusion reason `stale:review_after_elapsed`.

The decision is **not deleted or rejected** — it remains in the database with status `approved`. It is simply excluded from injection until a human reviews and either renews it (by updating `review_after`) or supersedes it.

The Decisions page surfaces stale decisions separately and flags decisions expiring within 14 days as a warning.

Use `review_after` for:
- Decisions tied to a specific time horizon ("use this library until we evaluate alternatives in Q3")
- Decisions whose underlying assumptions may erode over time
- Any decision you want to force yourself to revisit explicitly

---

## `effective_until`

An ISO date string. A hard expiry: once this date has passed, the decision is excluded from injection with reason `expired:effective_until`.

Unlike `review_after`, `effective_until` represents a known, intentional end date — the decision was always meant to stop being active at this point. After expiry the decision remains in history but is permanently excluded unless manually updated.

Use `effective_until` when you know in advance that a decision has a fixed end (a temporary exception, a time-boxed experiment).

---

## `reversibility`

Indicates how difficult it would be to undo this decision once acted upon.

| Value | Meaning |
|---|---|
| `low` | Hard to reverse — migration required, data changed, external commitments made. |
| `medium` | Moderately reversible with some effort. |
| `high` | Easy to change — configuration, naming, local convention. |

`reversibility` is a **review signal only** — it affects how the decision is displayed during the ratification step (low-reversibility proposals are visually flagged). It does not affect injection eligibility.

---

## `possible_conflicts`

An array of strings or `{id, title}` objects identifying other decisions this decision may conflict with.

At injection time, if two eligible decisions declare a conflict with each other (matched by title word overlap ≥ 50%), only the **more recently ratified** decision is injected. The other is excluded with reason `unresolved_conflict:<winning_id>`.

This is a passive conflict resolution mechanism — it prevents contradictory instructions from reaching an agent simultaneously. It does not prevent both decisions from existing in the database.

When writing a proposal that you know may conflict with an existing decision, populate `possible_conflicts` so the conflict is visible during review and handled correctly at injection time.

---

## Supersession

Supersession is an atomic write operation that:

1. Inserts a new `approved` decision.
2. Sets `status = 'superseded'` and `superseded_by = <new_id>` on all target decisions.

Both steps happen in a single database transaction. A superseded decision is permanently excluded from injection (`superseded_by` is checked before any other eligibility criteria).

**API:** `POST /api/decisions/supersede`

Required fields on the new decision:
- `status: "approved"`
- `ratified_by` (non-empty)
- `supersedes: [<id1>, <id2>, ...]` (at least one ID)

Constraints enforced:
- Target decisions must have status `approved` or `deferred`
- A decision cannot supersede itself
- A decision that is already superseded cannot be superseded again

---

## Injection eligibility — full exclusion reason taxonomy

When a decision is evaluated at injection time, it passes through `computeEligibilityWithReason()` in `lib/utils.ts`. The exclusion reasons returned are machine-readable and appear in the run audit trail.

| Reason | Cause |
|---|---|
| `status:<value>` | Decision is not `approved` |
| `superseded_by:<id>` | Decision has been replaced |
| `tier:history_only` | Transfer tier prevents injection |
| `tier:re_ratify` | Requires fresh ratification |
| `tier:explicit_not_requested` | `explicit` tier but caller did not set `explicit=true` |
| `confidence_below_threshold:<value>` | Confidence is below 0.6 |
| `expired:effective_until` | Past the hard expiry date |
| `stale:review_after_elapsed` | Past the review date, not renewed |
| `scope:project_mismatch` | Project scope doesn't match request context |
| `scope:app_mismatch` | App scope doesn't match |
| `scope:unknown(<value>)` | Unrecognised scope value |
| `unresolved_conflict:<id>` | Conflict with a more recently ratified decision |
| `invalid_confidence` | Confidence is not a valid number |
| `invalid_tier` | Transfer tier is not a recognised value |
| `invalid_effective_until` | Date string is not parseable |
| `invalid_review_after` | Date string is not parseable |

These reasons are logged on every `GET /api/memory` call and are visible on the Runs page under each run's exclusion detail.
