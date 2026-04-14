export type CompactProvenance = {
  sourceEntryId?: string;
  reviewItemId?: string;
  decisionId?: string;
  linkType?: string;
  decidedAt?: string;
  derivedFrom?: string[];
};

export function compactProvenance(input: CompactProvenance): CompactProvenance {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && (!(Array.isArray(value)) || value.length > 0)),
  ) as CompactProvenance;
}

export function reviewDecisionProvenance(reviewItemId: string, decidedAt: string): CompactProvenance {
  return compactProvenance({
    sourceEntryId: reviewItemId,
    reviewItemId,
    linkType: "direct-review",
    decidedAt,
    derivedFrom: [reviewItemId],
  });
}
