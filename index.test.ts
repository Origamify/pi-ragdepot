// Unit tests against a fake python bin: arg construction, python resolution,
// output parsing, error mapping, scope scrubbing. No real ragdepot needed.

import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as bridge from "./bridge";

let tmp: string;
let argsFile: string;

const FAKE_PYTHON = `#!/bin/sh
echo "$@" >> "$ARGS_FILE"
case "$FAKE_MODE" in
  depot-error) echo "error: cannot read: nope.txt" >&2; exit 1;;
  usage-error) echo "usage: ragdepot" >&2; exit 2;;
  max-buffer) head -c 40000000 /dev/zero;;
  add-silent) exit 0;;
esac
case "$*" in
  *" add "*)
    seen=0
    for a in "$@"; do
      if [ "$seen" = 1 ]; then case "$a" in /*) echo "indexed: $a";; esac; fi
      [ "$a" = "global" ] && seen=1
    done;;
  *query*)
    echo '[{"scope":"global","doc_id":"d1","title":"Notes","path":"/tmp/x.md","url":"","snippet":"[Intro] hello world","score":0.9123},{"scope":"global","doc_id":"d2","title":"Spec","path":"","url":"https://e.x/s","snippet":"raw text","score":0.5}]';;
  *stats*) echo '{"global": {"docs": 3, "chunks": 10}}';;
  *) echo "unknown command" >&2; exit 2;;
esac
exit 0
`;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ragdepot-test-"));
  argsFile = path.join(tmp, "args.txt");
  const bin = path.join(tmp, "fake-python");
  fs.writeFileSync(bin, FAKE_PYTHON);
  fs.chmodSync(bin, 0o755);
  process.env.RAGDEPOT_PYTHON = bin;
  process.env.DEPOT_ROOT = path.join(tmp, "data");
  process.env.ARGS_FILE = argsFile;
});

function recordedArgs(): string[] {
  return fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8").trim().split("\n") : [];
}

// ── Python resolution ──────────────────────────────────────────────
describe("resolvePython", () => {
  test("RAGDEPOT_PYTHON env wins", () => {
    expect(bridge.resolvePython({ RAGDEPOT_PYTHON: "/opt/py" }, "/no/ext")).toBe("/opt/py");
  });

  test("venv python picked when present", () => {
    const extDir = path.join(tmp, "ext");
    const venvPy = path.join(extDir, "ragdepot", ".venv", "bin", "python");
    fs.mkdirSync(path.dirname(venvPy), { recursive: true });
    fs.writeFileSync(venvPy, "#!/bin/sh\n");
    expect(bridge.resolvePython({}, extDir)).toBe(venvPy);
  });

  test("falls back to python3", () => {
    expect(bridge.resolvePython({}, path.join(tmp, "ext-empty"))).toBe("python3");
  });
});

// ── Pure parsing ───────────────────────────────────────────────────
describe("parsing", () => {
  test("parseAddOutput: indexed/unchanged lines, noise ignored", () => {
    expect(
      bridge.parseAddOutput("indexed: /a.md\nnoise\nunchanged:  /b.md\n\n"),
    ).toEqual([
      { status: "indexed", file: "/a.md" },
      { status: "unchanged", file: "/b.md" },
    ]);
  });

  test("scrubHits: scope stripped from every hit", () => {
    const hits = bridge.scrubHits([
      { scope: "global", doc_id: "d", title: "t", path: "p", url: "u", snippet: "s", score: 1 },
    ]);
    expect(hits[0]).not.toHaveProperty("scope");
    expect(JSON.stringify(hits)).not.toContain("scope");
    expect(hits[0].doc_id).toBe("d");
  });

  test("scrubHits: rejects non-list", () => {
    expect(() => bridge.scrubHits({})).toThrow();
  });

  test("flattenStats: flattens global scope, empty depot defaults to zero", () => {
    // the lib omits scopes with 0 docs — {} is a valid empty-depot response
    expect(bridge.flattenStats({ global: { docs: 3, chunks: 10 } })).toEqual({ docs: 3, chunks: 10 });
    expect(bridge.flattenStats({})).toEqual({ docs: 0, chunks: 0 });
  });
});

// ── End-to-end through the fake bin ────────────────────────────────
describe("operations (fake python)", () => {
  test("ragAdd: argv, outcomes, ingest log with sha256", async () => {
    const file = path.join(tmp, "notes.md");
    fs.writeFileSync(file, "hello depot\n");

    const outcomes = await bridge.ragAdd([file]);

    const args = recordedArgs();
    const argv = args[args.length - 1];
    expect(argv).toBe(
      `-m ragdepot --root ${process.env.DEPOT_ROOT} add --scope global ${file}`,
    );
    expect(outcomes).toEqual([{ status: "indexed", file }]);

    const logLine = JSON.parse(fs.readFileSync(bridge.sourcesLog(), "utf8").trim());
    expect(logLine.source).toBe(file);
    expect(logLine.status).toBe("indexed");
    expect(logLine.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(logLine.sha256).toBe(createHash("sha256").update("hello depot\n").digest("hex"));
  });

  test("ragQuery: argv and scrubbed hits", async () => {
    const hits = await bridge.ragQuery("hello world");
    const args = recordedArgs();
    const argv = args[args.length - 1];
    expect(argv).toBe(`-m ragdepot --root ${process.env.DEPOT_ROOT} query --scope global --json -- hello world`);
    expect(hits).toHaveLength(2);
    expect(JSON.stringify(hits)).not.toContain("scope");
    expect(hits[0]).toMatchObject({ doc_id: "d1", title: "Notes", score: 0.9123 });
  });

  test("ragStats: flattened counts", async () => {
    expect(await bridge.ragStats()).toEqual({ docs: 3, chunks: 10 });
    const args = recordedArgs();
    const argv = args[args.length - 1];
    expect(argv).toBe(`-m ragdepot --root ${process.env.DEPOT_ROOT} stats --json`);
  });

  test("ragAdd: exit 0 with no per-file lines → error, no log entry", async () => {
    fs.rmSync(bridge.sourcesLog(), { force: true });
    process.env.FAKE_MODE = "add-silent";
    try {
      await expect(bridge.ragAdd([path.join(tmp, "x.md")])).rejects.toThrow("no per-file results");
    } finally {
      delete process.env.FAKE_MODE;
    }
    expect(fs.existsSync(bridge.sourcesLog())).toBe(false);
  });

  test("exit 1 → depot error reason", async () => {
    process.env.FAKE_MODE = "depot-error";
    try {
      await expect(bridge.ragStats()).rejects.toThrow("cannot read: nope.txt");
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  test("exit 2 → extension error", async () => {
    process.env.FAKE_MODE = "usage-error";
    try {
      await expect(bridge.ragStats()).rejects.toThrow("exited 2");
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  test("abort → cancelled error", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(bridge.ragQuery("hello", ac.signal)).rejects.toThrow("cancelled");
  });

  test("ragAdd: empty list is a no-op — no subprocess, no log", async () => {
    const before = recordedArgs().length;
    const logBefore = fs.existsSync(bridge.sourcesLog());
    expect(await bridge.ragAdd([])).toEqual([]);
    expect(recordedArgs().length).toBe(before);
    expect(fs.existsSync(bridge.sourcesLog())).toBe(logBefore);
  });

  test("appendIngestLog: vanished file logs without sha256", () => {
    fs.rmSync(bridge.sourcesLog(), { force: true });
    bridge.appendIngestLog([{ file: path.join(tmp, "vanished.md"), status: "unchanged" }]);
    const line = JSON.parse(fs.readFileSync(bridge.sourcesLog(), "utf8").trim());
    expect(line).not.toHaveProperty("sha256");
    expect(line.status).toBe("unchanged");
  });

  test("stdout over maxBuffer → distinct overflow error, not a timeout", async () => {
    process.env.FAKE_MODE = "max-buffer";
    try {
      await expect(bridge.ragStats()).rejects.toThrow(/output exceeded 32 MB/);
    } finally {
      delete process.env.FAKE_MODE;
    }
  });
});
