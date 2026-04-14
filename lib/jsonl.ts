import fs from "fs";

export function readJsonlWithWarnings(filepath: string, label = filepath) {
  if (!fs.existsSync(filepath)) return { entries: [] as any[], warnings: [] as string[] };

  const warnings: string[] = [];
  const entries = fs
    .readFileSync(filepath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line, index) => {
      try {
        return [JSON.parse(line)];
      } catch (error) {
        warnings.push(`${label}: invalid JSONL at line ${index + 1}`);
        return [];
      }
    });

  if (warnings.length > 0) {
    console.warn(`[govinuity] ${warnings.join("; ")}`);
  }

  return { entries, warnings };
}
