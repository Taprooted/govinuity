import fs from "fs";
import path from "path";
import { logContinuityRun, generateRunId } from "./run-log";
import type { DecisionV2 } from "./utils";

const TIER_LABEL: Record<string, string> = {
  always:       "always active",
  by_project:   "active for this project",
  explicit:     "not auto-active",
  history_only: "history only",
  re_ratify:    "requires re-ratification",
};

/**
 * Format active decisions as instructional markdown for Claude Code context files.
 * The output is designed to be read as governing instructions, not just a list.
 */
export function generateDecisionsContent(
  decisions: DecisionV2[],
  options: { project?: string | null; generatedAt: string },
): string {
  const frontmatterLines = [
    `---`,
    `generated_at: ${options.generatedAt}`,
    `decisions_injected: ${decisions.length}`,
    `decisions_excluded: 0`,
  ];
  if (options.project) frontmatterLines.push(`project: ${options.project}`);
  frontmatterLines.push(`---`);
  const frontmatter = frontmatterLines.join("\n");

  const intro = decisions.length > 0
    ? `The following decisions have been reviewed and ratified. Apply them in your work unless this session explicitly overrides one with a clear reason.`
    : `No active decisions are currently ratified for this context.`;

  if (decisions.length === 0) return [frontmatter, ``, intro, ``].join("\n");

  const sections = decisions.map((d) => {
    const title = d.title || d.body.split("\n")[0].slice(0, 100);

    const meta: string[] = [];
    if (d.ratified_by) meta.push(`ratified_by: ${d.ratified_by}`);
    if (typeof d.confidence === "number") meta.push(`confidence: ${Math.round(d.confidence * 100)}%`);
    if (d.transfer_tier) meta.push(`scope: ${TIER_LABEL[d.transfer_tier] ?? d.transfer_tier}`);
    if (d.review_after) meta.push(`review_after: ${d.review_after.slice(0, 10)}`);

    const lines: string[] = [
      `### ${title}`,
      ``,
      ...(meta.length > 0 ? [`${meta.join(" · ")}`, ``] : []),
      d.body.trim(),
    ];

    if (d.rationale?.trim()) {
      lines.push(``, `**Why this is durable:** ${d.rationale.trim()}`);
    }

    if (d.reuse_instructions?.trim()) {
      lines.push(``, `**How to apply:** ${d.reuse_instructions.trim()}`);
    }

    return lines.join("\n");
  });

  return [frontmatter, ``, intro, ``, `---`, ``, sections.join(`\n\n---\n\n`)].join("\n") + "\n";
}

/**
 * Write the generated content to the target path, creating directories as needed.
 * Returns the number of bytes written.
 */
export function writeDecisionsFile(targetPath: string, content: string): number {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf-8");
  return Buffer.byteLength(content, "utf-8");
}

/**
 * Generate, write, and log a run record for a file-based injection event.
 */
export function generateAndWrite(
  decisions: DecisionV2[],
  targetPath: string,
  options: { project?: string | null; agent?: string | null },
): { run_id: string; path: string; decision_count: number; bytes: number } {
  const run_id = generateRunId();
  const generatedAt = new Date().toISOString();

  const content = generateDecisionsContent(decisions, {
    project: options.project,
    generatedAt,
  });

  const bytes = writeDecisionsFile(targetPath, content);

  // Log this as a Path-A injection event
  logContinuityRun({
    run_id,
    ts: generatedAt,
    project: options.project ?? null,
    app: null,
    agent: options.agent ?? "agents-md-generator",
    source: "file",
    injected_ids: decisions.map((d) => d.id),
    excluded: [],
    injected_count: decisions.length,
    excluded_count: 0,
  });

  return { run_id, path: targetPath, decision_count: decisions.length, bytes };
}
