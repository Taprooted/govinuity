import { getDb } from "../../../lib/db";
import { randomUUID } from "crypto";

const now = new Date().toISOString();

const ID_CONFIRM_DESTRUCTIVE = `seed-${randomUUID()}`;
const ID_POSTGRES            = `seed-${randomUUID()}`;
const ID_NO_SECRETS          = `seed-${randomUUID()}`;
const ID_API_ERROR_CODES     = `seed-${randomUUID()}`;

const SEED_DECISIONS = [
  // Proposed — these land in the review queue
  {
    id: ID_CONFIRM_DESTRUCTIVE,
    title: "Confirm destructive operations before executing",
    body: "Any operation that deletes, overwrites, or permanently modifies user data must present a confirmation step before proceeding. This applies to file deletions, database drops, and bulk updates.",
    rationale: "Irreversible operations caused data loss in two separate incidents. A confirmation gate catches mistakes before they compound.",
    status: "proposed",
    proposal_class: "durable_workflow_rule",
    scope: "global",
    transfer_tier: "always",
    confidence: 0.9,
    summary_for_human: "Require explicit confirmation before any destructive or irreversible operation.",
    why_surfaced: "Pattern appeared in multiple sessions where agents executed destructive operations without user confirmation.",
    reversibility: "low" as const,
    possible_conflicts: [] as Array<{ id: string; title: string }>,
    source_type: "harvest",
    created_at: now,
    updated_at: now,
  },
  {
    id: ID_POSTGRES,
    title: "Use Postgres for all new persistent data stores",
    body: "New services requiring persistent storage should use PostgreSQL. SQLite is acceptable for local tooling and prototypes. Avoid introducing new database engines without explicit architectural review.",
    rationale: "Fragmented storage choices (SQLite, MySQL, Mongo) in existing services have created operational overhead and inconsistent backup procedures.",
    status: "proposed",
    proposal_class: "architectural_decision",
    scope: "global",
    transfer_tier: "always",
    confidence: 0.75,
    summary_for_human: "Standardise on Postgres for new persistent data stores; SQLite stays for local tooling only.",
    why_surfaced: "Recurred across three project setup sessions — each time Postgres was chosen after deliberation over alternatives.",
    reversibility: "medium" as const,
    possible_conflicts: [
      { id: ID_CONFIRM_DESTRUCTIVE, title: "Confirm destructive operations before executing" },
    ] as Array<{ id: string; title: string }>,
    source_type: "harvest",
    created_at: now,
    updated_at: now,
  },
  // Approved — these are in the active decision log
  {
    id: ID_NO_SECRETS,
    title: "Never commit secrets or credentials to the repository",
    body: "API keys, passwords, tokens, and private certificates must never be committed to version control. Use environment variables or a secrets manager. Rotate any credential that is accidentally committed immediately.",
    rationale: "Secrets in git history are permanently exposed even after deletion. Rotation after accidental commit is the minimum remediation.",
    status: "approved",
    proposal_class: "durable_constraint",
    scope: "global",
    transfer_tier: "always",
    confidence: 0.99,
    summary_for_human: "Hard constraint: no secrets in version control, ever.",
    why_surfaced: null as string | null,
    reversibility: "low" as const,
    possible_conflicts: [] as Array<{ id: string; title: string }>,
    ratified_by: "human",
    source_type: "manual",
    created_at: now,
    updated_at: now,
  },
  {
    id: ID_API_ERROR_CODES,
    title: "API error responses must include a machine-readable error code",
    body: "All API error responses must include a structured error code alongside the HTTP status. The error code should be a stable string (e.g. `auth.token_expired`) that clients can match without parsing message text.",
    rationale: "Clients have been forced to parse error message strings to distinguish error types, which breaks when messages change.",
    status: "approved",
    proposal_class: "durable_constraint",
    scope: "global",
    transfer_tier: "always",
    confidence: 0.88,
    summary_for_human: "API errors need a stable machine-readable code, not just an HTTP status.",
    why_surfaced: "Emerged from two separate debugging sessions where agents had to string-match error messages.",
    reversibility: "low" as const,
    possible_conflicts: [] as Array<{ id: string; title: string }>,
    ratified_by: "human",
    source_type: "harvest",
    created_at: now,
    updated_at: now,
  },
];

export async function POST() {
  const db = getDb();

  const existing = db.prepare("SELECT COUNT(*) as count FROM decisions").get() as { count: number };
  if (existing.count > 0) {
    return Response.json({ ok: false, error: "Database already has decisions — seed only works on an empty database." }, { status: 409 });
  }

  const stmt = db.prepare(`
    INSERT INTO decisions (
      id, title, body, rationale, status, proposal_class, scope, transfer_tier,
      confidence, summary_for_human, why_surfaced, reversibility, ratified_by,
      source_type, created_at, updated_at,
      supersedes, possible_conflicts, tags, context_keys, assumptions, provenance, related_objects,
      follow_up_state
    ) VALUES (
      @id, @title, @body, @rationale, @status, @proposal_class, @scope, @transfer_tier,
      @confidence, @summary_for_human, @why_surfaced, @reversibility, @ratified_by,
      @source_type, @created_at, @updated_at,
      '[]', @possible_conflicts, '[]', '[]', '[]', '{}', '[]',
      'open'
    )
  `);

  const insert = db.transaction(() => {
    for (const d of SEED_DECISIONS) {
      stmt.run({
        id: d.id,
        title: d.title ?? null,
        body: d.body,
        rationale: d.rationale ?? null,
        status: d.status,
        proposal_class: d.proposal_class ?? null,
        scope: d.scope ?? "global",
        transfer_tier: d.transfer_tier ?? "always",
        confidence: d.confidence ?? 0.8,
        summary_for_human: d.summary_for_human ?? null,
        why_surfaced: d.why_surfaced ?? null,
        reversibility: d.reversibility ?? null,
        possible_conflicts: JSON.stringify(d.possible_conflicts ?? []),
        ratified_by: (d as any).ratified_by ?? null,
        source_type: d.source_type ?? null,
        created_at: d.created_at,
        updated_at: d.updated_at,
      });
    }
  });

  insert();

  const proposed = SEED_DECISIONS.filter((d) => d.status === "proposed").length;
  const approved = SEED_DECISIONS.filter((d) => d.status === "approved").length;

  return Response.json({ ok: true, proposed, approved });
}
