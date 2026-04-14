import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { PATHS } from "../../../lib/config";

const META_FILE = path.join(PATHS.metaDir, "harvest_meta.json");

type HarvestMeta = {
  running: boolean;
  started_at?: string;
  running_hours?: number;
  last_run_ts?: string;
  last_run_hours?: number;
  last_submitted?: number;
  last_annotations?: number;
  last_duration_ms?: number;
  last_output_tail?: string[];
};

function readMeta(): HarvestMeta {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, "utf8"));
  } catch {
    return { running: false };
  }
}

function writeMeta(meta: HarvestMeta) {
  fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

function parseOutput(output: string): { submitted: number; annotations: number } {
  let submitted = 0;
  let annotations = 0;
  const subMatch = output.match(/Submitted (\d+)\/\d+ candidates/);
  if (subMatch) submitted = parseInt(subMatch[1], 10);
  const annotMatch = output.match(/Submitted (\d+) annotation/);
  if (annotMatch) annotations = parseInt(annotMatch[1], 10);
  return { submitted, annotations };
}

function runScript(args: string[], stdin?: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", args, {
      cwd: process.cwd(),
      timeout: 120_000,
      env: env ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    proc.on("close", () => resolve({ stdout, stderr }));
    proc.on("error", reject);
  });
}

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "";
const DEFAULT_SESSION_DIR = path.join(HOME, ".claude", "projects");

function tildify(p: string): string {
  if (HOME && p.startsWith(HOME)) return "~" + p.slice(HOME.length);
  return p;
}

export async function GET() {
  const meta = readMeta();
  const sessionDir = tildify(process.env.GOVINUITY_SESSION_DIR ?? DEFAULT_SESSION_DIR);
  return Response.json({ meta, sessionDir });
}

export async function POST(request: Request) {
  const meta = readMeta();
  if (meta.running) {
    return Response.json({ ok: false, error: "A harvest is already in progress." }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));

  // mode: "sessions" (auto-scan) | "text" (paste via stdin)
  const mode: string = body.mode ?? "sessions";
  const hours: number = Math.max(1, Math.min(168, Number(body.hours) || 48));
  const text: string | undefined = typeof body.text === "string" ? body.text : undefined;
  const source: string = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "paste";
  const sessionDir: string | undefined = typeof body.sessionDir === "string" && body.sessionDir.trim() ? body.sessionDir.trim() : undefined;

  const scriptPath = path.join(process.cwd(), "scripts", "harvest_proposals.py");
  if (!fs.existsSync(scriptPath)) {
    return Response.json({ error: "harvest_proposals.py not found in scripts/" }, { status: 500 });
  }

  if (mode === "text") {
    if (!text?.trim()) {
      return Response.json({ error: "No text provided." }, { status: 400 });
    }
    // Text input is fast and synchronous — no need for running flag
    const started = Date.now();
    try {
      const { stdout, stderr } = await runScript(
        ["scripts/harvest_proposals.py", "--submit", "--input", "-", "--source", source],
        text,
      );
      const duration_ms = Date.now() - started;
      const combined = (stdout + "\n" + stderr).trim();
      const lines = combined.split("\n").filter(Boolean);
      const tail = lines.slice(-20);
      const { submitted, annotations } = parseOutput(combined);
      return Response.json({ ok: true, submitted, annotations, duration_ms, output: tail });
    } catch (err: unknown) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : "Script error" }, { status: 500 });
    }
  }

  // sessions mode — mark running, spawn async
  writeMeta({ ...meta, running: true, started_at: new Date().toISOString(), running_hours: hours });
  const started = Date.now();

  const env = sessionDir ? { ...process.env, GOVINUITY_SESSION_DIR: sessionDir } : process.env;

  return new Promise<Response>((resolve) => {
    runScript(["scripts/harvest_proposals.py", "--submit", "--since", `${hours}h`], undefined, env)
      .then(({ stdout, stderr }) => {
        const duration_ms = Date.now() - started;
        const combined = (stdout + "\n" + stderr).trim();
        const lines = combined.split("\n").filter(Boolean);
        const tail = lines.slice(-20);
        const { submitted, annotations } = parseOutput(combined);
        writeMeta({
          running: false,
          last_run_ts: new Date().toISOString(),
          last_run_hours: hours,
          last_submitted: submitted,
          last_annotations: annotations,
          last_duration_ms: duration_ms,
          last_output_tail: tail,
        });
        resolve(Response.json({ ok: true, submitted, annotations, duration_ms, output: tail }));
      })
      .catch((err: Error) => {
        writeMeta({ ...readMeta(), running: false });
        resolve(Response.json({ ok: false, error: err.message }, { status: 500 }));
      });
  });
}
