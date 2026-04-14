import { getDb } from "../../../lib/db";

export async function GET() {
  const db = getDb();

  const review = (db.prepare("SELECT reviewed, project, original_entry FROM review_queue").all() as Record<string, any>[])
    .map((r) => ({
      ...r,
      reviewed: r.reviewed === 1,
      original_entry: typeof r.original_entry === "string" ? JSON.parse(r.original_entry) : r.original_entry,
    }));

  const decisions = db.prepare("SELECT status, follow_up_state FROM decisions").all() as Record<string, any>[];

  const pendingItems = review.filter((item) => !item.reviewed);
  const pendingReview = pendingItems.length;
  const highPriorityReview = pendingItems.filter((item) => item.original_entry?.severity === "high").length;

  const openFollowUps = decisions.filter((d) => (d.follow_up_state ?? "open") === "open").length;
  const proposedDecisions = decisions.filter((d) => d.status === "proposed").length;
  const ratifiedDecisions = decisions.filter((d) => d.status === "approved").length;
  const totalRuns = (db.prepare("SELECT COUNT(*) as n FROM continuity_runs").get() as { n: number }).n;

  return Response.json({
    counts: {
      home: pendingReview,
      review: pendingReview,
      proposals: proposedDecisions,
      decisions_total: ratifiedDecisions,
      runs: totalRuns,
    },
    pulse: {
      pendingReview,
      decisions: decisions.length,
      openFollowUps,
      highPriorityReview,
      urgency: highPriorityReview > 0 ? "high" : pendingReview > 0 || openFollowUps > 0 ? "medium" : "low",
    },
  });
}
