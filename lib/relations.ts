export type LinkStrength = "direct" | "context-related" | "inferred";

export function directDecisionLink(decision: any, targetId: string) {
  return decision?.provenance?.reviewItemId === targetId || decision?.id === targetId;
}

export function contextRelated(decisionOrEntry: any, context: string | undefined) {
  if (!context) return false;
  // v2 entries: match against context_keys (e.g. "project:workbench")
  if (Array.isArray(decisionOrEntry?.context_keys) && decisionOrEntry.context_keys.length > 0) {
    return decisionOrEntry.context_keys.some(
      (key: string) => key === context || key.startsWith(`${context}:`) || context.startsWith(`${key}:`),
    );
  }
  // v1 fallback: legacy context field
  return decisionOrEntry?.context === context;
}

export function inferTextRelation(text: string | undefined, probe: string | undefined) {
  if (!text || !probe) return false;
  const normalizedProbe = probe.trim().slice(0, 20);
  if (!normalizedProbe) return false;
  return text.includes(normalizedProbe);
}

export function relationLabel(strength: LinkStrength | string) {
  if (strength === "direct" || strength === "direct-review") return "direct";
  if (strength === "context-related" || strength === "context-derived") return "context related";
  if (strength === "legacy-normalized") return "legacy normalized";
  return "inferred";
}

export function relationTone(strength: LinkStrength | string) {
  if (strength === "direct" || strength === "direct-review") return "success" as const;
  if (strength === "context-related" || strength === "context-derived") return "accent" as const;
  if (strength === "legacy-normalized") return "neutral" as const;
  return "warning" as const;
}
