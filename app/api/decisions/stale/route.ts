import { getStaleDecisions } from "../../../../lib/decision-write";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const project = searchParams.get("project") ?? undefined;
  const decisions = getStaleDecisions(project);
  return Response.json({ decisions, count: decisions.length });
}
