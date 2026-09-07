#!/usr/bin/env bun
// Wiring only. Runtime npm dependencies are exact-pinned and dynamically loaded
// into Bun's cache. Stdout belongs exclusively to the stdio JSON-RPC transport.
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = await import("zod");
import { updateIndex } from "../fts5/wiki-search.ts";
import { CONFIG } from "./config.ts";
import { wikiSearch, wikiRegexSearch, wikiGetPage, wikiGetRelated, wikiList, wikiResolve, wikiSearchAndRead,
  wikiGetSources, wikiHealthSummary, wikiLintSummary, wikiAuditVisibility, type ToolCtx } from "./tools.ts";
function reply(obj: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }], ...(isError ? { isError: true } : {}) };
}
function run<T extends { ok: boolean }>(fn: () => T) {
  try { const r = fn(); return reply(r, r.ok === false); }
  catch (e) { return reply({ ok: false, reason: e instanceof Error ? e.message : String(e) }, true); }
}
export function buildServer(ctx: ToolCtx): InstanceType<typeof McpServer> {
  const server = new McpServer({ name: "llm-wiki", version: "0.3.0" });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool("wiki_search", {
    description: "Lexical BM25 search over visible wiki pages. Returns ranked paths, snippets, tags, and optional confidence/contested signals. Not semantic search.", annotations,
    inputSchema: { query: z.string().describe("natural-language or keyword query"), folder: z.string().optional(),
      type: z.string().optional(), tag: z.string().optional(), limit: z.number().int().min(1).max(50).optional(), mode: z.enum(["auto", "strict", "broad"]).optional() },
  }, async (args) => run(() => wikiSearch(ctx, args)));
  server.registerTool("wiki_regex_search", {
    description: "Exact Rust-regex search over gated, redacted Markdown. Returns path/line/byte-column/match/line_text. No look-around or backreferences. Line numbers refer to the redacted page view.", annotations,
    inputSchema: { pattern: z.string().min(1).max(500), folder: z.string().optional(), type: z.string().optional(), tag: z.string().optional(),
      caseSensitive: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async (args) => run(() => wikiRegexSearch(ctx, args)));
  server.registerTool("wiki_get_page", {
    description: "Read a visible page by wiki-relative .md path. Optionally select a heading section or bound output length. Never writes.", annotations,
    inputSchema: { path: z.string(), section: z.string().optional(), maxChars: z.number().int().min(1).max(100000).optional() },
  }, async (args) => run(() => wikiGetPage(ctx, args)));
  server.registerTool("wiki_get_related", {
    description: "Visible outbound wikilinks and confirmed inbound backlinks, with relation, anchor, and context snippet.", annotations,
    inputSchema: { path: z.string() },
  }, async (args) => run(() => wikiGetRelated(ctx, args)));
  server.registerTool("wiki_list", {
    description: "Catalog of visible pages, without bodies. Filter by type/tag/folder/status/confidence/visibility, sort, and paginate. updated sort uses filesystem modification time.", annotations,
    inputSchema: { type: z.string().optional(), tag: z.string().optional(), folder: z.string().optional(), sort: z.enum(["title", "updated", "created"]).optional(),
      order: z.enum(["asc", "desc"]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(0).max(1000).optional(),
      status: z.string().optional(), confidence: z.string().optional(), visibility: z.enum(["public", "private"]).optional() },
  }, async (args) => run(() => wikiList(ctx, args)));
  server.registerTool("wiki_resolve", {
    description: "Resolve a wikilink/stem/[[target]] to a visible canonical path or visible ambiguity candidates. Out-of-scope targets fail closed.", annotations,
    inputSchema: { target: z.string() },
  }, async (args) => run(() => wikiResolve(ctx, args)));
  server.registerTool("wiki_search_and_read", {
    description: "Search and read in one call: ranked visible pages with bounded excerpts.", annotations,
    inputSchema: { query: z.string(), folder: z.string().optional(), type: z.string().optional(), tag: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(), mode: z.enum(["auto", "strict", "broad"]).optional(), maxCharsPerPage: z.number().int().min(1).max(20000).optional() },
  }, async (args) => run(() => wikiSearchAndRead(ctx, args)));
  server.registerTool("wiki_get_sources", {
    description: "Declared sources/raw_sources, raw-source metadata, and processed_to provenance for a gated page. References are not permission to read their targets.", annotations,
    inputSchema: { path: z.string() },
  }, async (args) => run(() => wikiGetSources(ctx, args)));
  server.registerTool("wiki_health_summary", {
    description: "Read-only structural health counts for the selected vault: checked/errors/warnings/info. Never repairs content.", annotations, inputSchema: {},
  }, async () => run(() => wikiHealthSummary(ctx)));
  server.registerTool("wiki_lint_summary", {
    description: "Read-only layer-aware lint counts for the selected vault. Never repairs content.", annotations, inputSchema: {},
  }, async () => run(() => wikiLintSummary(ctx)));
  server.registerTool("wiki_audit_visibility", {
    description: "Audit the explicitly published PUBLIC surface (path and type), regardless of caller scope.", annotations, inputSchema: {},
  }, async () => run(() => wikiAuditVisibility(ctx)));
  return server;
}
async function main(): Promise<void> {
  console.log = (...args: unknown[]) => console.error(...args);
  const ctx: ToolCtx = { wikiDir: CONFIG.wikiDir, dbPath: CONFIG.dbPath, scope: CONFIG.scope };
  updateIndex({ wikiDir: ctx.wikiDir, dbPath: ctx.dbPath, quiet: true });
  await buildServer(ctx).connect(new StdioServerTransport());
  console.error(`[llm-wiki] ready — scope=${ctx.scope} wiki=${ctx.wikiDir}`);
}
if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
