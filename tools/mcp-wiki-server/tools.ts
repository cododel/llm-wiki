// Readonly MCP handlers. All returned pages and discovery results use access.ts.
import { join } from "node:path";
import { searchIndex, updateIndex, parseMarkdownPage, scanMarkdownFiles, type SearchMode, type SearchResult } from "../fts5/wiki-search.ts";
import { TOOL_ROOT } from "../lib/paths.ts";
import { authorize, isServable, listServable, readServable, readVisibility, redact, type AccessCtx, type Scope } from "./access.ts";
import { buildResolver } from "./resolver.ts";

export type ToolCtx = { wikiDir: string; dbPath: string; scope: Scope };
const MAX_LIMIT = 50;
const access = (ctx: ToolCtx): AccessCtx => ({ wikiDir: ctx.wikiDir, scope: ctx.scope });
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
function reindex(ctx: ToolCtx): void { updateIndex({ wikiDir: ctx.wikiDir, dbPath: ctx.dbPath, quiet: true }); }
function titleOf(ctx: ToolCtx, relPath: string): string {
  try { return redact(parseMarkdownPage(join(ctx.wikiDir, relPath), ctx.wikiDir).title || relPath); } catch { return relPath; }
}
const ftsPhrase = (s: string): string => `"${s.replace(/"/g, '""')}"`;
function extractSection(md: string, section: string): string | null {
  const want = section.replace(/^#+\s*/, "").trim().toLowerCase(); const lines = md.split("\n");
  let start = -1; let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === want) { start = i; level = m[1].length; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").trimEnd() + "\n";
}
function fmBlock(text: string): string {
  if (!text.startsWith("---\n")) return "";
  const end = text.indexOf("\n---\n", 4); return end === -1 ? "" : text.slice(4, end);
}
function fmScalar(text: string, field: string): string | undefined {
  for (const line of fmBlock(text).split("\n")) {
    const m = new RegExp(`^${field}:\\s*(.+)$`).exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "") || undefined;
  }
  return undefined;
}
function fmList(text: string, field: string): string[] {
  const lines = fmBlock(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = new RegExp(`^${field}:\\s*(.*)$`).exec(lines[i]); if (!m) continue;
    const rest = m[1].trim();
    if (rest.startsWith("[") && rest.endsWith("]")) return rest.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    if (rest) return [rest.replace(/^["']|["']$/g, "")];
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]; if (line && !/^\s/.test(line)) break;
      const t = line.trim(); if (t.startsWith("- ")) out.push(t.slice(2).trim().replace(/^["']|["']$/g, ""));
    }
    return out;
  }
  return [];
}
function snippetAround(body: string, needle: string, radius = 100): string {
  const idx = body.indexOf(needle); if (idx === -1) return "";
  const start = Math.max(0, idx - radius); const end = Math.min(body.length, idx + needle.length + radius);
  const core = body.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + core + (end < body.length ? "…" : "");
}
function bodyOf(acc: AccessCtx, rel: string): string { const res = readServable(acc, rel); return res.ok ? res.markdown : ""; }
export type SearchArgs = { query: string; folder?: string; type?: string; tag?: string; limit?: number; mode?: SearchMode };
export function wikiSearch(ctx: ToolCtx, args: SearchArgs) {
  const acc = access(ctx); const limit = clamp(args.limit ?? 10, 1, MAX_LIMIT); reindex(ctx);
  const rows = searchIndex(args.query, { dbPath: ctx.dbPath, limit: clamp(limit * 4, 1, MAX_LIMIT),
    folder: args.folder ?? "", type: args.type ?? "", tag: args.tag ?? "", mode: args.mode ?? "auto" });
  const results = [];
  for (const row of rows) {
    if (results.length >= limit) break;
    const auth = authorize(acc, row.path); if (!auth.ok) continue;
    const meta = readVisibility(auth.absPath);
    results.push({ path: row.path, title: redact(row.title), type: row.type, tags: row.tags.map(redact), score: row.score,
      snippet: redact(row.snippet), ...(meta.confidence ? { confidence: meta.confidence } : {}), ...(meta.contested ? { contested: true } : {}) });
  }
  return { ok: true as const, query: args.query, count: results.length, results };
}
export type RegexSearchArgs = { pattern: string; folder?: string; type?: string; tag?: string; caseSensitive?: boolean; limit?: number };
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function textField(value: unknown): string { const v = object(value)?.text; return typeof v === "string" ? v : ""; }
/** Rust-regex search on gated, already-redacted page views. Never hand private
 * files or raw secret-bearing page bodies to a result-producing search path. */
export function wikiRegexSearch(ctx: ToolCtx, args: RegexSearchArgs) {
  const pattern = args.pattern ?? "";
  if (!pattern) return { ok: false as const, reason: "pattern is required" };
  if (pattern.length > 500) return { ok: false as const, reason: "pattern exceeds 500 characters" };
  const limit = clamp(args.limit ?? 50, 1, 100);
  const pages = listServable(access(ctx), { folder: args.folder, type: args.type, tag: args.tag });
  const results: Array<{ path: string; title: string; line: number; column: number; match: string; line_text: string }> = [];
  let truncated = false;
  for (const page of pages) {
    const visible = readServable(access(ctx), page.path); if (!visible.ok) continue;
    const cmd = ["rg", "--json", "--line-number", "--color", "never", "--no-messages", "--max-count", String(limit + 1),
      ...(args.caseSensitive === false ? ["--ignore-case"] : []), "-e", pattern, "--", "-"];
    let proc: ReturnType<typeof Bun.spawnSync>;
    try {
      proc = Bun.spawnSync(cmd, { cwd: ctx.wikiDir, stdin: Buffer.from(visible.markdown), stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      return { ok: false as const, reason: `regex search unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (proc.exitCode !== 0 && proc.exitCode !== 1) {
      const detail = proc.stderr.toString().trim().replace(/\s+/g, " ");
      return { ok: false as const, reason: `invalid or unsupported regex${detail ? `: ${detail}` : ""}` };
    }
    for (const raw of proc.stdout.toString().split("\n")) {
      if (!raw) continue;
      let event: Record<string, unknown> | null;
      try { event = object(JSON.parse(raw)); } catch { continue; }
      if (event?.type !== "match") continue;
      const data = object(event.data); if (!data) continue;
      const lineText = textField(data.lines).replace(/\r?\n$/, "");
      const line = typeof data.line_number === "number" ? data.line_number : 0;
      const subs = Array.isArray(data.submatches) ? data.submatches : [];
      for (const value of subs) {
        if (results.length >= limit) { truncated = true; break; }
        const sub = object(value); if (!sub) continue;
        results.push({ path: page.path, title: page.title, line, column: (typeof sub.start === "number" ? sub.start : 0) + 1,
          match: textField(sub.match), line_text: lineText.length > 500 ? lineText.slice(0, 500) + "…" : lineText });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { ok: true as const, pattern, count: results.length, truncated, results };
}
export type GetPageArgs = { path: string; section?: string; maxChars?: number };
export function wikiGetPage(ctx: ToolCtx, args: GetPageArgs) {
  const res = readServable(access(ctx), args.path);
  if (!res.ok) return { ok: false as const, reason: res.reason };
  let markdown = res.markdown; let section: string | undefined;
  if (args.section !== undefined) {
    const sliced = extractSection(markdown, args.section);
    if (sliced === null) return { ok: false as const, reason: `section not found: ${args.section}` };
    markdown = sliced; section = args.section;
  }
  let truncated = false;
  if (args.maxChars !== undefined && markdown.length > clamp(args.maxChars, 1, 100_000)) {
    markdown = markdown.slice(0, clamp(args.maxChars, 1, 100_000)); truncated = true;
  }
  return { ok: true as const, path: res.relPath, markdown, ...(section !== undefined ? { section } : {}),
    ...(truncated ? { truncated: true } : {}), ...(res.meta.confidence ? { confidence: res.meta.confidence } : {}),
    ...(res.meta.contested ? { contested: true } : {}) };
}
export type RelatedEntry = { path: string; title: string; relation: "outbound" | "inbound"; anchor: string; snippet: string };
export function wikiGetRelated(ctx: ToolCtx, args: { path: string }) {
  const acc = access(ctx); const target = authorize(acc, args.path);
  if (!target.ok) return { ok: false as const, reason: target.reason };
  const targetRel = target.relPath; reindex(ctx);
  const files = [...scanMarkdownFiles(ctx.wikiDir).keys()]; const resolve = buildResolver(files);
  const targetBody = bodyOf(acc, targetRel); const outbound = new Map<string, RelatedEntry>();
  const linkTargets = (body: string): string[] => [...body.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
  for (const link of linkTargets(targetBody)) {
    const r = resolve(link, targetRel);
    if (!r || r === "ambiguous" || r === targetRel || !isServable(acc, r) || outbound.has(r)) continue;
    outbound.set(r, { path: r, title: titleOf(ctx, r), relation: "outbound", anchor: link, snippet: snippetAround(targetBody, `[[${link}`) });
  }
  const noExt = targetRel.replace(/\.md$/, ""); const stem = noExt.split("/").pop() ?? noExt;
  const expr = `wikilinks:${ftsPhrase(stem)} OR wikilinks:${ftsPhrase(noExt)}`;
  const inbound = new Map<string, RelatedEntry>(); let candidates: SearchResult[];
  try { candidates = searchIndex(expr, { dbPath: ctx.dbPath, mode: "raw", limit: MAX_LIMIT }); } catch { candidates = []; }
  for (const c of candidates) {
    if (c.path === targetRel || inbound.has(c.path)) continue;
    const cBody = readServable(acc, c.path); if (!cBody.ok) continue;
    const anchor = linkTargets(cBody.markdown).find((l) => resolve(l, c.path) === targetRel);
    if (anchor !== undefined) inbound.set(c.path, { path: c.path, title: redact(c.title), relation: "inbound", anchor,
      snippet: snippetAround(cBody.markdown, `[[${anchor}`) });
  }
  return { ok: true as const, path: targetRel, outbound: [...outbound.values()], inbound: [...inbound.values()] };
}
export type ListArgs = {
  type?: string; tag?: string; folder?: string; sort?: "title" | "updated" | "created"; order?: "asc" | "desc";
  offset?: number; limit?: number; status?: string; confidence?: string; visibility?: string;
};
export function wikiList(ctx: ToolCtx, args: ListArgs = {}) {
  const acc = access(ctx);
  const entries = listServable(acc, { type: args.type, tag: args.tag, folder: args.folder });
  const scan = scanMarkdownFiles(ctx.wikiDir);
  let rows = entries.flatMap((entry) => {
    const res = readServable(acc, entry.path); if (!res.ok) return [];
    return [{ entry, mtime: scan.get(entry.path)?.mtime ?? 0, created: fmScalar(res.markdown, "created") ?? "",
      status: fmScalar(res.markdown, "status") ?? "", visibility: fmScalar(res.markdown, "visibility") ?? "" }];
  });
  if (args.status) rows = rows.filter((r) => r.status === args.status);
  if (args.confidence) rows = rows.filter((r) => r.entry.confidence === args.confidence);
  if (args.visibility) rows = rows.filter((r) => r.visibility === args.visibility);
  const sort = args.sort ?? "title";
  rows.sort((a, b) => {
    if (sort === "updated") return a.mtime - b.mtime;
    if (sort === "created") return a.created < b.created ? -1 : a.created > b.created ? 1 : 0;
    return a.entry.title < b.entry.title ? -1 : a.entry.title > b.entry.title ? 1 : 0;
  });
  if ((args.order ?? (sort === "updated" ? "desc" : "asc")) === "desc") rows.reverse();
  const total = rows.length; const offset = Math.max(0, args.offset ?? 0);
  const limit = args.limit !== undefined ? clamp(args.limit, 0, 1000) : total;
  const pages = rows.slice(offset, offset + limit).map((r) => r.entry);
  return { ok: true as const, count: total, offset, limit: pages.length, pages };
}
export type ResolveArgs = { target: string };
function normalizeTarget(raw: string): string {
  let t = raw.trim(); if (t.startsWith("[[") && t.endsWith("]]")) t = t.slice(2, -2);
  return t.split("#")[0].split("|")[0].trim().replace(/\.md$/i, "");
}
export function wikiResolve(ctx: ToolCtx, args: ResolveArgs) {
  const acc = access(ctx); reindex(ctx);
  // Hidden pages must not turn a unique public result into a revealing ambiguity.
  const files = [...scanMarkdownFiles(ctx.wikiDir).keys()].filter((f) => isServable(acc, f));
  const resolve = buildResolver(files); const norm = normalizeTarget(args.target); const r = resolve(norm);
  if (r === "ambiguous") {
    const stem = norm.split("/").pop() ?? norm;
    const candidates = files.filter((f) => {
      const parts = f.replace(/\.md$/i, "").split("/");
      return parts.some((_, i) => parts.slice(i).join("/") === norm) || parts[parts.length - 1] === stem;
    }).map((f) => ({ path: f, title: titleOf(ctx, f) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (!candidates.length) return { ok: false as const, reason: "not found" };
    return { ok: true as const, target: args.target, ambiguous: true as const, candidates };
  }
  if (r && isServable(acc, r)) return { ok: true as const, target: args.target, path: r, title: titleOf(ctx, r) };
  return { ok: false as const, reason: "not found" };
}
export type SearchAndReadArgs = SearchArgs & { maxCharsPerPage?: number };
export function wikiSearchAndRead(ctx: ToolCtx, args: SearchAndReadArgs) {
  const maxChars = clamp(args.maxCharsPerPage ?? 2000, 1, 20_000); const acc = access(ctx);
  const search = wikiSearch(ctx, { ...args, limit: clamp(args.limit ?? 3, 1, MAX_LIMIT) });
  const results = search.results.flatMap((r) => {
    const page = readServable(acc, r.path); if (!page.ok) return [];
    const truncated = page.markdown.length > maxChars;
    return [{ path: r.path, title: r.title, type: r.type, score: r.score, truncated,
      excerpt: truncated ? page.markdown.slice(0, maxChars) : page.markdown,
      ...(r.confidence ? { confidence: r.confidence } : {}), ...(r.contested ? { contested: true } : {}) }];
  });
  return { ok: true as const, query: args.query, count: results.length, results };
}
export function wikiGetSources(ctx: ToolCtx, args: { path: string }) {
  const res = readServable(access(ctx), args.path); if (!res.ok) return { ok: false as const, reason: res.reason };
  const text = res.markdown; const source_kind = fmScalar(text, "source_kind");
  const source_channel = fmScalar(text, "source_channel"); const source_url = fmScalar(text, "source_url");
  return { ok: true as const, path: res.relPath, sources: fmList(text, "sources"), raw_sources: fmList(text, "raw_sources"),
    processed_to: fmList(text, "processed_to"), ...(source_kind ? { source_kind } : {}),
    ...(source_channel ? { source_channel } : {}), ...(source_url ? { source_url } : {}) };
}
function runToolJson(ctx: ToolCtx, scriptRel: string): unknown {
  const proc = Bun.spawnSync([process.execPath, "run", join(TOOL_ROOT, scriptRel), "--json"], {
    cwd: ctx.wikiDir, env: { ...process.env, WIKI_DIR: ctx.wikiDir }, stdout: "pipe", stderr: "pipe",
  });
  try { return JSON.parse(proc.stdout.toString()); } catch { return null; }
}
export function wikiHealthSummary(ctx: ToolCtx) {
  const data = object(runToolJson(ctx, "tools/wiki_health.ts"));
  if (!data || typeof data.checked !== "number") return { ok: false as const, reason: "health check unavailable" };
  const count = (key: string): number => typeof data[key] === "number" ? data[key] : 0;
  return { ok: true as const, checked: data.checked, errors: count("errors"), warnings: count("warnings"), info: count("info") };
}
export function wikiLintSummary(ctx: ToolCtx) {
  const data = object(runToolJson(ctx, "tools/wiki_lint.ts"));
  if (!data) return { ok: false as const, reason: "lint unavailable" };
  const summary: Record<string, number> = {};
  for (const [key, value] of Object.entries(data)) if (Array.isArray(value)) summary[key] = value.length;
  return { ok: true as const, summary };
}
export function wikiAuditVisibility(ctx: ToolCtx) {
  const entries = listServable({ wikiDir: ctx.wikiDir, scope: "public" }, {});
  return { ok: true as const, exposed_count: entries.length, exposed: entries.map((e) => ({ path: e.path, type: e.type })) };
}
