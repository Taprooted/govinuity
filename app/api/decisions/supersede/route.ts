import { supersede } from "../../../../lib/decision-write";
import type { DecisionV2, DecisionScope, TransferTier } from "../../../../lib/utils";

const VALID_SCOPES = new Set<DecisionScope>(["global","project","app","task","session","agent"]);
const VALID_TIERS = new Set<TransferTier>(["always","by_project","explicit","history_only","re_ratify"]);

function validateIsoDate(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") return `${field} must be a string`;
  const d = new Date(value);
  if (isNaN(d.getTime())) return `${field} is not a valid ISO date: "${value}"`;
  return null;
}

export async function POST(request: Request) {
  const body = await request.json();

  const {
    title,
    body: bodyText,
    rationale,
    supersedes,
    project,
    ratified_by,
    note,
    confidence,
    transfer_tier,
    scope,
    scope_ref,
    review_after,
    effective_until,
    assumptions,
    revisit_trigger,
    reuse_instructions,
    tags,
    context_keys,
    source_agent,
  } = body;

  if (!bodyText?.trim()) {
    return Response.json({ error: "body is required" }, { status: 400 });
  }
  if (!supersedes || !Array.isArray(supersedes) || supersedes.length === 0) {
    return Response.json({ error: "supersedes must be a non-empty array of decision IDs" }, { status: 400 });
  }
  if (!ratified_by?.trim()) {
    return Response.json({ error: "ratified_by is required — superseding decisions must have explicit authority" }, { status: 400 });
  }

  const scopeValue = scope ?? (project ? "project" : "global");
  if (!VALID_SCOPES.has(scopeValue)) {
    return Response.json({ error: `scope must be one of: ${[...VALID_SCOPES].join(", ")}` }, { status: 400 });
  }
  const tierValue = transfer_tier ?? (project ? "by_project" : "always");
  if (!VALID_TIERS.has(tierValue)) {
    return Response.json({ error: `transfer_tier must be one of: ${[...VALID_TIERS].join(", ")}` }, { status: 400 });
  }
  if (confidence !== undefined) {
    const c = Number(confidence);
    if (isNaN(c) || c < 0 || c > 1) {
      return Response.json({ error: "confidence must be a number between 0 and 1" }, { status: 400 });
    }
  }
  const euErr = validateIsoDate(effective_until, "effective_until");
  if (euErr) return Response.json({ error: euErr }, { status: 400 });
  const raErr = validateIsoDate(review_after, "review_after");
  if (raErr) return Response.json({ error: raErr }, { status: 400 });

  const now = new Date().toISOString();
  const cleanBody = bodyText.trim();
  const titleRaw = title?.trim() || cleanBody.split("\n")[0].trim();
  const derivedTitle = titleRaw.length > 78 ? titleRaw.slice(0, 78) + "…" : titleRaw;
  const resolvedProject = project ?? null;

  const newDecision: DecisionV2 = {
    id: `dec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    project_id: resolvedProject,
    title: derivedTitle,
    body: cleanBody,
    rationale: rationale?.trim() ?? "",
    source_type: "direct",
    source_id: null,
    source_agent: source_agent ?? null,
    source_loop: null,
    ratified_by: ratified_by.trim(),
    created_at: now,
    updated_at: now,
    status: "approved",
    scope: scopeValue,
    scope_ref: scope_ref ?? resolvedProject ?? null,
    confidence: confidence != null ? Number(confidence) : 0.8,
    transfer_tier: tierValue,
    effective_until: effective_until ?? null,
    review_after: review_after ?? null,
    supersedes,
    superseded_by: null,
    related_objects: [],
    assumptions: assumptions ?? [],
    revisit_trigger: revisit_trigger ?? null,
    reuse_instructions: reuse_instructions ?? null,
    provenance: { linkType: "supersession", derivedFrom: supersedes },
    tags: tags ?? [],
    context_keys: context_keys ?? (resolvedProject ? [`project:${resolvedProject}`] : []),
    note: note?.trim() ?? null,
    // Legacy compat aliases
    follow_up_state: "open",
  };

  try {
    const result = supersede(newDecision);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: String((error as Error).message || error) }, { status: 400 });
  }
}
