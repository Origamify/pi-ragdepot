// pi-ragdepot — persistent searchable knowledge base for the agent.
// Thin tools over the vendored ragdepot python CLI (chunk → embed → hybrid
// dense+BM25 search). Global scope only; scope never appears in tool schemas
// or model-facing output.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as bridge from "./bridge";

// ── Schemas ────────────────────────────────────────────────────────
const AddParams = Type.Object({
  files: Type.Array(Type.String(), {
    description: "Files to index (plain text/markdown/code files). Relative paths resolve against the cwd.",
  }),
});

const QueryParams = Type.Object({
  text: Type.String({ description: "Natural-language or keyword query." }),
});

const HitSchema = Type.Object({
  doc_id: Type.String(),
  title: Type.String(),
  path: Type.String(),
  url: Type.String(),
  snippet: Type.String(),
  score: Type.Number(),
});

const QueryOutput = Type.Object({ hits: Type.Array(HitSchema) });

const StatsOutput = Type.Object({ docs: Type.Number(), chunks: Type.Number() });

// ── Formatting ─────────────────────────────────────────────────────
function formatHits(hits: bridge.Hit[]): string {
  if (hits.length === 0) return "No matches.";
  return hits
    .map((h) => `${h.title} · ${h.score.toFixed(4)}\n  ${h.path || h.url}\n  ${h.snippet}`)
    .join("\n\n");
}

// ── Extension ──────────────────────────────────────────────────────
export default function ragDepot(pi: ExtensionAPI) {
  pi.registerTool({
    name: "rag_add",
    label: "Rag add",
    description:
      "Index plain text/markdown/code files into the persistent knowledge base for later semantic " +
      "search. Re-adding an unchanged file is a no-op; changed files are re-indexed. " +
      "First call may take a while (downloads the embedding model, once).",
    parameters: AddParams,
    annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_toolCallId, params, signal) {
      const outcomes = await bridge.ragAdd(params.files, signal);
      const text = outcomes.map((o) => `${o.status}: ${o.file}`).join("\n");
      return { content: [{ type: "text", text }], details: { outcomes } };
    },
  });

  pi.registerTool({
    name: "rag_query",
    label: "Rag query",
    description:
      "Search the persistent knowledge base (hybrid semantic + keyword, top 8 hits). " +
      "Use for recalling previously indexed notes, docs and code.",
    parameters: QueryParams,
    annotations: { readOnlyHint: true },
    outputSchema: QueryOutput,
    async execute(_toolCallId, params, signal) {
      const hits = await bridge.ragQuery(params.text, signal);
      return {
        content: [{ type: "text", text: formatHits(hits) }],
        structuredContent: { hits },
        details: { hits },
      };
    },
  });

  pi.registerTool({
    name: "rag_stats",
    label: "Rag stats",
    description: "Report knowledge base size: document and chunk counts.",
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true },
    outputSchema: StatsOutput,
    async execute(_toolCallId, _params, signal) {
      const stats = await bridge.ragStats(signal);
      return {
        content: [{ type: "text", text: `docs: ${stats.docs}, chunks: ${stats.chunks}` }],
        structuredContent: stats,
        details: stats,
      };
    },
  });
}
