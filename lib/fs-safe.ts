import fs from "fs";
import path from "path";

export function atomicWriteText(targetPath: string, content: string) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tempPath = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tempPath, content, "utf-8");
  fs.renameSync(tempPath, targetPath);
}

export function appendJsonlAtomic(targetPath: string, entry: unknown) {
  const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf-8") : "";
  const line = JSON.stringify(entry) + "\n";
  atomicWriteText(targetPath, existing + line);
}
