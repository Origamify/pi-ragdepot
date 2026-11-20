# pi-ragdepot

Persistent, searchable knowledge base for the pi agent. Indexes text files
into a local RAG depot (chunk → embed → hybrid dense + BM25 search over
sqlite) and exposes it as three tools.

- `rag_add` — index plain text/markdown/code files (idempotent; re-adding an
  unchanged file is a no-op, changed files are re-indexed)
- `rag_query` — hybrid semantic + keyword search, top 8 hits
- `rag_stats` — document and chunk counts

## Tools

| Tool | Params | Result |
|---|---|---|
| `rag_add` | `files: string[]` | per-file `indexed:` / `unchanged:` lines |
| `rag_query` | `text: string` | `outputSchema` + `structuredContent` (hits array); text = one block per hit: `title · score`, path/url, snippet |
| `rag_stats` | — | `{ docs, chunks }` |

Design constraint: **global scope only**. Scope is hard-coded in the bridge
and invisible to the model — never appears in tool schemas, descriptions, or
any model-facing output (the bridge strips it from CLI results).

## Layout

```
~/.pi/agent/extensions/pi-ragdepot/
├── index.ts           # factory: registers the three tools
├── bridge.ts          # python resolution, execFile, output parsing, scrubbing
├── index.test.ts      # bun tests against a fake python bin
├── setup.sh           # idempotent: clone lib + build venv
├── package.json
├── README.md
└── ragdepot/          # python lib clone (https://github.com/Origamify/ragdepot.git)
    └── .venv/         # bridge resolves ragdepot/.venv/bin/python

~/.ragdepot-pi/        # data — separate from the extension dir, survives reinstalls
├── sources/ingest.jsonl   # append-only ingest log (ts, source, status, sha256)
└── global/depot.db        # sqlite index (chunks + vectors + BM25)
```

Source files are never copied — only chunk text and vectors live in
`depot.db`. Back up `~/.ragdepot-pi` and everything ingested is safe.

## Setup

```bash
~/.pi/agent/extensions/pi-ragdepot/setup.sh
```

Idempotent — clones the lib, creates the venv (default interpreter is `python3.14`
on PATH, lib requires Python ≥ 3.14; override with `RAGDEPOT_SETUP_PYTHON`),
installs deps. Safe to re-run anytime; an existing clone/venv is reused. Needs
network access: git+GitHub (clone) and PyPI (wheels).

The embed model (~130 MB, `minishlab/potion-base-8M`) downloads on first
`rag_add`/`rag_query`. The lib caches it in `/tmp/fastembed_cache` (fastembed
default), so a reboot/tmp cleanup triggers a one-time re-download. One model
per depot root — switching means re-indexing.

## Config

No settings file. Two env vars, read at call time:

- `DEPOT_ROOT` — data directory (default `~/.ragdepot-pi`)
- `RAGDEPOT_PYTHON` — explicit python override (default resolution:
  `<ext>/ragdepot/.venv/bin/python`, then `python3` on PATH)

## Behavior

- Each tool call spawns one short-lived `python -m ragdepot` subprocess
  (`execFile`): 5 min timeout for add (first-run model download), 1 min
  otherwise. User cancel kills the child.
- Exit codes: 0 ok / 1 depot error (message surfaced to the model as the
  tool error) / 2 usage (extension error — a bridge bug). Timeout, user cancel
  and output overflow (> 32 MB) surface as `timed out after Ns` /
  `cancelled` / `output exceeded 32 MB`.
- `rag_add` with an empty file list is a no-op — no subprocess, no log entry.
- Paths are resolved to absolute before spawning (ragdepot keys docs by
  resolved path).
- Parallel tool calls are safe: separate processes, sqlite WAL.
- Text files only. Binaries fail with ragdepot's clean `cannot read` error.

## Testing

```bash
cd ~/.pi/agent/extensions/pi-ragdepot
bun install
bun run typecheck   # tsc --noEmit
bun test            # 17 tests: argv construction, python resolution, parsing,
                    # error mapping (depot/usage/cancel), scope scrubbing — fake
                    # python bin, no venv needed
```

## Reinstall & maintenance

All state lives in `~/.ragdepot-pi`, outside the extension dir — so a full
`rm -rf` of the extension loses nothing permanent: only the venv and the lib
clone, both re-creatable.

- **Reinstall**: `rm -rf` the extension dir, restore the source files,
  run `setup.sh`. Data, ingest log, and index are untouched.
- **Update the lib**: `git -C ragdepot pull && RAGDEPOT_SETUP_UPGRADE=1
  ./setup.sh`.
- **Update extension code**: edit the `.ts` files; pi picks them up on
  restart. No build step.

## Out of scope

PDF/binary parsing, blob archiving of originals, long-lived daemon bridge,
`rag_delete`, multiple scopes, human-facing `/rag` command.

---


- Built with AI assistance (PI agent / uHarness) — code, tests, docs.
- Models used: Qwen / GLM.
- Code is mostly AI-written, human-reviewed. Human focus on modularization, clarity of purpose, and the contracts the AI implements against.
- Docs are mostly written autonomously by the agent and reviewed strictly.
- Tests are mostly AI-generated, then maintained and reviewed, with certain human requirements on what must be tested.
- Goal: deliver good solutions to the problem — oversized results for the effort — not to control every detail.
