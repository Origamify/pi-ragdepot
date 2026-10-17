// bridge.ts — JS → python (ragdepot CLI) boundary: python resolution, subprocess
// exec, output parsing, scope scrubbing, ingest log. No pi imports (testable).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Constants & config ─────────────────────────────────────────────
const EXT_DIR = __dirname;
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".ragdepot-pi");
const ADD_TIMEOUT_MS = 300_000; // add may download the embed model on first run
const READ_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024; // model-download progress on stderr
const SCOPE = "global"; // hard-coded: global-only by design; invisible to the model

export function dataDir(): string {
  return process.env.DEPOT_ROOT ? path.resolve(process.env.DEPOT_ROOT) : DEFAULT_DATA_DIR;
}

export function sourcesLog(): string {
  return path.join(dataDir(), "sources", "ingest.jsonl");
}

// ── Python resolution (first hit wins) ─────────────────────────────
// 1. RAGDEPOT_PYTHON env (explicit override)
// 2. <ext>/ragdepot/.venv/bin/python (normal case)
// 3. python3 on PATH (fallback)
export function resolvePython(env: NodeJS.ProcessEnv = process.env, extDir: string = EXT_DIR): string {
  if (env.RAGDEPOT_PYTHON) {
    // path-like overrides resolve to absolute; bare names keep PATH search
    return env.RAGDEPOT_PYTHON.includes(path.sep) ? path.resolve(env.RAGDEPOT_PYTHON) : env.RAGDEPOT_PYTHON;
  }
  const venvPython = path.join(extDir, "ragdepot", ".venv", "bin", "python");
  if (fs.existsSync(venvPython)) return venvPython;
  return "python3";
}

// ── Subprocess ─────────────────────────────────────────────────────
interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

function execDepot(args: string[], opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    execFile(
      resolvePython(),
      ["-m", "ragdepot", "--root", dataDir(), ...args],
      { signal: opts.signal, timeout: opts.timeoutMs, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") {
          // killed before clean exit: abort, buffer overflow and timeout get distinct messages
          if (opts.signal?.aborted) return reject(new Error("cancelled"));
          if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(err.message))
            return reject(new Error(`output exceeded ${MAX_BUFFER / 1024 / 1024} MB`));
          if (err.killed) return reject(new Error(`timed out after ${opts.timeoutMs / 1000}s`));
          return reject(err); // spawn failure
        }
        resolve({ code: err ? (err.code as number) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Run ragdepot; exit 1 → throw with the depot's reason, other failures → throw. */
async function run(args: string[], opts: { signal?: AbortSignal; timeoutMs: number }): Promise<string> {
  const out = await execDepot(args, opts);
  if (out.code === 0) return out.stdout;
  if (out.code === 1) {
    const reason = out.stderr.trim().replace(/^error:\s*/, "");
    throw new Error(reason || "ragdepot failed");
  }
  throw new Error(`ragdepot exited ${out.code}: ${out.stderr.trim() || out.stdout.trim()}`);
}

// ── Scope scrubbing (scope must never reach the model) ────────────
export type Hit = {
  doc_id: string;
  title: string;
  path: string;
  url: string;
  snippet: string;
  score: number;
};

function scrubHit(raw: Record<string, unknown>): Hit {
  const clone: Record<string, unknown> = { ...raw };
  delete clone.scope; // scope is implementation detail — never model-facing
  return clone as unknown as Hit;
}

export function scrubHits(raw: unknown): Hit[] {
  if (!Array.isArray(raw)) throw new Error("unexpected query output: not a hit list");
  return raw.map((h) => scrubHit(h as Record<string, unknown>));
}

export function flattenStats(raw: unknown): { docs: number; chunks: number } {
  if (typeof raw !== "object" || raw === null) throw new Error("unexpected stats output");
  // the lib omits scopes with 0 docs — a missing global scope is a legitimately empty depot, not breakage
  const perScope = (raw as Record<string, { docs: number; chunks: number }>)[SCOPE];
  return { docs: perScope?.docs ?? 0, chunks: perScope?.chunks ?? 0 };
}

// ── Operations ─────────────────────────────────────────────────────
export interface AddOutcome {
  file: string;
  status: "indexed" | "unchanged";
}

export function parseAddOutput(stdout: string): AddOutcome[] {
  const outcomes: AddOutcome[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(indexed|unchanged):\s*(.+)$/);
    if (m) outcomes.push({ status: m[1] as AddOutcome["status"], file: m[2].trim() });
  }
  return outcomes;
}

/** Sha of file content, or undefined if unreadable (e.g. deleted after indexing). */
function sha256(file: string): string | undefined {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return undefined; // JSON.stringify omits the key
  }
}

/** Append one JSON line per file to the extension-owned ingest log. */
export function appendIngestLog(outcomes: AddOutcome[], now: Date = new Date()): void {
  if (outcomes.length === 0) return;
  const log = sourcesLog();
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const ts = now.toISOString();
  const lines = outcomes
    .map((o) => JSON.stringify({ ts, source: o.file, status: o.status, sha256: sha256(o.file) }))
    .join("\n");
  fs.appendFileSync(log, lines + "\n");
}

export async function ragAdd(files: string[], signal?: AbortSignal): Promise<AddOutcome[]> {
  if (files.length === 0) return []; // no-op: never spawn a usage-error exit
  const abs = files.map((f) => path.resolve(f));
  const stdout = await run(["add", "--scope", SCOPE, ...abs], { signal, timeoutMs: ADD_TIMEOUT_MS });
  const outcomes = parseAddOutput(stdout);
  if (outcomes.length === 0) throw new Error("unexpected add output: no per-file results");
  appendIngestLog(outcomes);
  return outcomes;
}

export async function ragQuery(text: string, signal?: AbortSignal): Promise<Hit[]> {
  const stdout = await run(["query", "--scope", SCOPE, "--json", "--", text], { signal, timeoutMs: READ_TIMEOUT_MS });
  return scrubHits(JSON.parse(stdout));
}

export async function ragStats(signal?: AbortSignal): Promise<{ docs: number; chunks: number }> {
  const stdout = await run(["stats", "--json"], { signal, timeoutMs: READ_TIMEOUT_MS });
  return flattenStats(JSON.parse(stdout));
}
