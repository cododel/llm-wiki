#!/usr/bin/env bun
/**
 * Bun/TypeScript FTS5 search for the LLM Wiki.
 * Adapted from ObsidianDataWeave's memory_index.py in the source implementation.
 * Uses bun:sqlite, indexes wikilinks, and maintains a disposable local database.
 */
import { Glob } from "bun";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { PACKAGING_DIRS, resolveDbPath, resolveWikiDir } from "../lib/paths.ts";

export type Command = "build" | "update" | "status" | "search";
export type SearchMode = "auto" | "strict" | "broad" | "raw";
export type CliOptions = {
  cmd: Command; query: string; limit: number; folder: string; tag: string;
  type: string; prefix: boolean; raw: boolean; mode: SearchMode; json: boolean;
};
export type ParsedFrontmatter = { title?: string; type?: string; tags: string[] };
export type ParsedPage = {
  title: string; headings: string; tags: string[]; type: string;
  wikilinks: string[]; body: string; path: string; folder: string;
};
export type IndexStats = { db: string; indexed: number; removed: number; total: number };
export type SearchResult = {
  score: number; path: string; folder: string; type: string;
  title: string; tags: string[]; snippet: string;
};
export type Status = {
  db: string; exists: boolean; pages?: number; sizeKb?: number;
  tokenizer?: string; schemaVersion?: string; lastUpdate?: string;
};

const DEFAULT_WIKI_DIR = resolveWikiDir();
const DEFAULT_DB_PATH = resolveDbPath(DEFAULT_WIKI_DIR);
const TOKENIZER = "unicode61 remove_diacritics 2";
const SCHEMA_VERSION = "1";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_SEARCH_MODE: SearchMode = "auto";
const NATURAL_QUERY_STOPWORDS = new Set([
  "а", "без", "бы", "в", "во", "вот", "где", "для", "до", "есть", "еще", "ещё",
  "же", "за", "заметка", "заметки", "заметок", "записи", "запись", "и", "или", "как", "какая", "какие", "какий", "каким", "какого", "какой",
  "которые", "который", "ли", "мб", "мы", "на", "над", "надо", "найди", "найти", "не", "но", "о", "об",
  "от", "по", "под", "покажи", "после", "почему", "при", "про", "с", "со", "страниц", "страница", "страницы", "стоит", "там", "тут",
  "что", "чтобы", "это", "этой", "этот", "эту", "я",
  "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be",
  "by", "can", "could", "do", "does", "find", "for", "from", "has", "have", "how", "i", "in",
  "is", "it", "me", "note", "notes", "of", "on", "or", "page", "pages", "please", "should", "show", "that", "the", "this",
  "to", "vs", "what", "when", "where", "which", "why", "with", "would", "you",
]);
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const HEADING_RE = /^#{1,6}\s+(.+)$/gm;
const WIKILINK_RE = /!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const FACTCHECK_BATCH_RE = /^readouts\/\d{4}-\d{2}-\d{2}-factcheck-.*-batch-\d+\.md$/;
const SKIP_DIR_PARTS = new Set([".git", ".obsidian", ".hermes", ".claude", ".trash", "node_modules", "__pycache__"]);
const ROOT_META_FILES = new Set(["AGENTS.md", "SCHEMA.md", "README.md", "index.md", "log.md"]);
const QUERY_ALIASES: Record<string, string[]> = {
  "канбан": ["kanban"], "директус": ["directus"], "гермес": ["hermes"],
  "память": ["памяти"], "памяти": ["память"], "агент": ["агента"], "агента": ["агент"],
};

function uniq(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function normalizeRelPath(path: string): string { return path.split(sep).join("/").replace(/^\.\//, ""); }
function dequote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1).trim();
  return trimmed;
}
function fileStemFromRel(relPath: string): string { return (relPath.split("/").pop() ?? relPath).replace(/\.md$/i, ""); }
function splitHyphenTerms(value: string): string | null {
  const base = value.split("/").pop() ?? value;
  return base.includes("-") ? base.replace(/-/g, " ").trim() : null;
}
function parseTagValue(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map((item) => dequote(item.trim())).filter(Boolean);
  return [dequote(value)].filter(Boolean);
}
export function stripFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}
export function parseFrontmatter(fm: string): ParsedFrontmatter {
  const out: ParsedFrontmatter = { tags: [] };
  const lines = fm.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const title = /^title:\s*(.*)$/.exec(line);
    if (title) { out.title = dequote(title[1] ?? ""); continue; }
    const type = /^type:\s*(.*)$/.exec(line);
    if (type) { out.type = dequote(type[1] ?? ""); continue; }
    const tags = /^tags:\s*(.*)$/.exec(line);
    if (tags) {
      const inline = tags[1] ?? "";
      if (inline.trim()) { out.tags = parseTagValue(inline); continue; }
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j];
        if (/^\S[^:]*:\s*/.test(next)) break;
        const item = /^\s*-\s*(.*)$/.exec(next);
        if (item) collected.push(dequote(item[1] ?? ""));
        i = j;
      }
      out.tags = collected.filter(Boolean);
    }
  }
  return out;
}
export function extractHeadings(body: string): string[] { return [...body.matchAll(HEADING_RE)].map((m) => (m[1] ?? "").trim()).filter(Boolean); }
export function extractWikilinks(body: string): string[] {
  const terms: string[] = [];
  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = (match[1] ?? "").trim();
    if (!target) continue;
    terms.push(target);
    const base = target.split("/").pop();
    if (base && base !== target) terms.push(base);
    const split = splitHyphenTerms(target);
    if (split) terms.push(split);
  }
  return uniq(terms);
}
export function resolveType(relPath: string, fmType = ""): string {
  if (fmType) return fmType;
  if (relPath.startsWith("raw/")) return "raw-source";
  if (relPath.startsWith("readouts/")) return "readout";
  if (relPath.startsWith("ideas/")) return "idea";
  if (relPath.startsWith("notes/")) return "note";
  if (relPath.startsWith("drafts/posts/")) return "post-draft";
  if (relPath.startsWith("drafts/articles/")) return "article-draft";
  if (relPath.startsWith("drafts/")) return "unknown";
  if (relPath.startsWith("concepts/")) return "concept";
  if (relPath.startsWith("entities/")) return "entity";
  if (relPath.startsWith("comparisons/")) return "comparison";
  if (relPath.startsWith("queries/")) return "query";
  if (relPath.startsWith("adr/")) return "adr";
  if (relPath.startsWith("pages/")) return "meta";
  if (ROOT_META_FILES.has(relPath) || /^log-\d{4}/.test(relPath)) return "meta";
  return "note";
}
export function shouldIndexPath(relPathInput: string): boolean {
  const relPath = normalizeRelPath(relPathInput);
  if (!relPath.endsWith(".md")) return false;
  if (relPath === "index.md" || relPath === "log.md" || /^log-\d{4}/.test(relPath)) return false;
  if (relPath === ".factcheck-log.md" || FACTCHECK_BATCH_RE.test(relPath)) return false;
  const parts = relPath.split("/");
  if (parts.some((part) => SKIP_DIR_PARTS.has(part))) return false;
  if (parts[0] === "_archive" || PACKAGING_DIRS.has(parts[0])) return false;
  return true;
}
function titleFromParts(fmTitle: string | undefined, h1: string | undefined, stem: string): string { return uniq([fmTitle ?? "", h1 ?? "", stem]).join(" "); }
export function parseMarkdownPage(absPath: string, wikiDir: string): ParsedPage {
  const text = readFileSync(absPath, "utf8");
  const relPath = normalizeRelPath(relative(wikiDir, absPath));
  const { frontmatter, body } = stripFrontmatter(text);
  const fm = parseFrontmatter(frontmatter);
  const headings = extractHeadings(body);
  const h1 = headings[0];
  const stem = fileStemFromRel(relPath);
  const folder = relPath.includes("/") ? relPath.split("/").slice(0, -1).join("/") : ".";
  return { title: titleFromParts(fm.title, h1, stem), headings: headings.join(" "), tags: fm.tags,
    type: resolveType(relPath, fm.type), wikilinks: extractWikilinks(body), body, path: relPath, folder };
}
export function scanMarkdownFiles(wikiDir = DEFAULT_WIKI_DIR): Map<string, { mtime: number; size: number }> {
  const files = new Map<string, { mtime: number; size: number }>();
  const glob = new Glob("**/*.md");
  for (const rel of glob.scanSync(wikiDir)) {
    const relPath = normalizeRelPath(rel);
    if (!shouldIndexPath(relPath)) continue;
    const stat = statSync(join(wikiDir, relPath));
    files.set(relPath, { mtime: stat.mtimeMs, size: stat.size });
  }
  return files;
}
export function openDb(dbPath = DEFAULT_DB_PATH): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}
export function ensureSchema(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const existingVersion = getMeta(db, "schema_version");
  const existingTokenizer = getMeta(db, "tokenizer");
  if ((existingVersion && existingVersion !== SCHEMA_VERSION) || (existingTokenizer && existingTokenizer !== TOKENIZER)) {
    db.exec("DROP TABLE IF EXISTS pages_fts"); db.exec("DROP TABLE IF EXISTS files");
  }
  db.exec("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL)");
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    title, headings, tags, type, wikilinks, body, path UNINDEXED, folder UNINDEXED,
    tokenize="${TOKENIZER}", prefix='2 3'
  )`);
  setMeta(db, "schema_version", SCHEMA_VERSION);
  setMeta(db, "tokenizer", TOKENIZER);
}
export function updateIndex(opts: { wikiDir?: string; dbPath?: string; full?: boolean; quiet?: boolean } = {}): IndexStats {
  const wikiDir = opts.wikiDir ?? DEFAULT_WIKI_DIR;
  const dbPath = opts.dbPath ?? resolveDbPath(wikiDir);
  const db = openDb(dbPath);
  try {
    if (opts.full) { db.exec("DROP TABLE IF EXISTS pages_fts"); db.exec("DROP TABLE IF EXISTS files"); }
    ensureSchema(db);
    const onDisk = scanMarkdownFiles(wikiDir);
    const inDb = new Map<string, { mtime: number; size: number }>();
    for (const row of db.query("SELECT path, mtime, size FROM files").all() as Array<{ path: string; mtime: number; size: number }>) inDb.set(row.path, { mtime: row.mtime, size: row.size });
    const changed = [...onDisk.entries()].filter(([path, sig]) => {
      const old = inDb.get(path);
      return !old || Math.abs(old.mtime - sig.mtime) > 1e-6 || old.size !== sig.size;
    }).map(([path]) => path);
    const removed = [...inDb.keys()].filter((path) => !onDisk.has(path));
    const deleteFts = db.query("DELETE FROM pages_fts WHERE path = ?");
    const deleteFile = db.query("DELETE FROM files WHERE path = ?");
    const insertFts = db.query(`INSERT INTO pages_fts(title, headings, tags, type, wikilinks, body, path, folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const upsertFile = db.query(`INSERT INTO files(path, mtime, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size`);
    const applyChanges = db.transaction(() => {
      for (const rel of removed) { deleteFts.run(rel); deleteFile.run(rel); }
      for (const rel of changed) {
        const parsed = parseMarkdownPage(join(wikiDir, rel), wikiDir);
        deleteFts.run(rel);
        insertFts.run(parsed.title, parsed.headings, parsed.tags.join(" "), parsed.type,
          parsed.wikilinks.join(" "), parsed.body, parsed.path, parsed.folder);
        const sig = onDisk.get(rel);
        if (sig) upsertFile.run(rel, sig.mtime, sig.size);
      }
      setMeta(db, "last_update", String(Math.floor(Date.now() / 1000)));
    });
    applyChanges();
    const stats = { db: dbPath, indexed: changed.length, removed: removed.length, total: onDisk.size };
    if (!opts.quiet) {
      console.log(`Index ${opts.full ? "rebuilt" : "updated"}: ${stats.indexed} indexed, ${stats.removed} removed, ${stats.total} pages total`);
      console.log(`DB: ${dbPath}`);
    }
    return stats;
  } finally { db.close(); }
}
export function statusIndex(opts: { wikiDir?: string; dbPath?: string } = {}): Status {
  const dbPath = opts.dbPath ?? resolveDbPath(opts.wikiDir ?? DEFAULT_WIKI_DIR);
  if (!existsSync(dbPath)) return { db: dbPath, exists: false };
  const db = openDb(dbPath);
  try {
    ensureSchema(db);
    const row = db.query("SELECT count(*) AS count FROM files").get() as { count: number };
    const meta = Object.fromEntries((db.query("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
    return { db: dbPath, exists: true, pages: row.count, sizeKb: Math.floor(statSync(dbPath).size / 1024),
      tokenizer: meta.tokenizer, schemaVersion: meta.schema_version, lastUpdate: meta.last_update ?? "never" };
  } finally { db.close(); }
}
function quotedTermWithAliases(term: string, prefix: boolean): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"${prefix ? "*" : ""}`;
  const terms = uniq([term, ...(QUERY_ALIASES[term.toLowerCase()] ?? [])]);
  return terms.length === 1 ? quote(terms[0]) : `(${terms.map((value) => quote(value)).join(" OR ")})`;
}
function quotedTagFilter(tag: string): string { return `tags:"${tag.replaceAll('"', '""')}"`; }
function normalizeQueryTerms(query: string): string[] {
  const terms = (query.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? []).map((term) => term.trim()).filter(Boolean);
  if (terms.length === 0) return [];
  const meaningful = terms.filter((term) => {
    const lower = term.toLowerCase();
    return !NATURAL_QUERY_STOPWORDS.has(lower) && !(lower.length === 1 && !/\d/.test(lower));
  });
  return meaningful.length > 0 ? meaningful : terms;
}
export function buildMatchExpr(query: string, opts: { prefix: boolean; raw: boolean; tag: string; mode?: SearchMode }): string {
  const mode: SearchMode = opts.raw ? "raw" : (opts.mode ?? "strict");
  if (mode === "raw") {
    const rawExpr = query.trim();
    if (!rawExpr) throw new Error("empty query");
    return opts.tag ? `(${rawExpr}) AND ${quotedTagFilter(opts.tag)}` : rawExpr;
  }
  const terms = normalizeQueryTerms(query);
  if (terms.length === 0) throw new Error("empty query");
  const quoted = terms.map((term, index) => quotedTermWithAliases(term, opts.prefix && index === terms.length - 1));
  let expr = quoted.join(mode === "broad" ? " OR " : " AND ");
  if (opts.tag) expr = `(${expr}) AND ${quotedTagFilter(opts.tag)}`;
  return expr;
}
function normalizeSnippet(value: string | null): string { return (value ?? "").split(/\s+/).filter(Boolean).join(" "); }
function normalizeSearchMode(mode: SearchMode | string | undefined, raw: boolean | undefined): SearchMode {
  if (raw) return "raw";
  return mode === "auto" || mode === "strict" || mode === "broad" || mode === "raw" ? mode : DEFAULT_SEARCH_MODE;
}
function executeSearch(db: Database, expr: string, folder: string, type: string, limit: number): SearchResult[] {
  const rows = db.query(`SELECT path, folder, type, title, tags,
      snippet(pages_fts, 5, '«', '»', '…', 16) AS snip,
      bm25(pages_fts, 10.0, 4.0, 6.0, 3.0, 3.0, 1.0) AS rank
    FROM pages_fts WHERE pages_fts MATCH ?
      AND (? = '' OR folder = ? OR substr(folder, 1, length(?) + 1) = ? || '/')
      AND (? = '' OR type = ?) ORDER BY rank, path LIMIT ?`).all(
      expr, folder, folder, folder, folder, type, type, limit,
    ) as Array<{ path: string; folder: string; type: string; title: string; tags: string; snip: string | null; rank: number }>;
  return rows.map((row) => ({ score: Number((-row.rank).toFixed(3)), path: row.path, folder: row.folder,
    type: row.type, title: row.title, tags: row.tags.split(/\s+/).filter(Boolean), snippet: normalizeSnippet(row.snip) }));
}
export function searchIndex(query: string, opts: {
  wikiDir?: string; dbPath?: string; limit?: number; folder?: string; tag?: string;
  type?: string; prefix?: boolean; raw?: boolean; mode?: SearchMode;
} = {}): SearchResult[] {
  const dbPath = opts.dbPath ?? resolveDbPath(opts.wikiDir ?? DEFAULT_WIKI_DIR);
  if (!existsSync(dbPath)) throw new Error(`index not built yet (${dbPath})`);
  const folder = (opts.folder ?? "").replace(/\/+$/, "");
  const type = opts.type ?? "";
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const prefix = opts.prefix ?? false;
  const tag = opts.tag ?? "";
  const mode = normalizeSearchMode(opts.mode, opts.raw);
  const db = openDb(dbPath);
  try {
    ensureSchema(db);
    if (mode === "auto") {
      const strictResults = executeSearch(db, buildMatchExpr(query, { prefix, raw: false, tag, mode: "strict" }), folder, type, limit);
      if (strictResults.length > 0) return strictResults;
      return executeSearch(db, buildMatchExpr(query, { prefix, raw: false, tag, mode: "broad" }), folder, type, limit);
    }
    return executeSearch(db, buildMatchExpr(query, { prefix, raw: mode === "raw", tag, mode }), folder, type, limit);
  } finally { db.close(); }
}
export function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0) return { cmd: "status", query: "", limit: DEFAULT_LIMIT, folder: "", tag: "", type: "", prefix: false, raw: false, mode: DEFAULT_SEARCH_MODE, json: false };
  const commands = new Set(["build", "update", "status", "search"]);
  const first = argv[0];
  const cmd = commands.has(first) ? first as Command : "search";
  const args = commands.has(first) ? argv.slice(1) : argv;
  const opts: CliOptions = { cmd, query: "", limit: DEFAULT_LIMIT, folder: "", tag: "", type: "", prefix: false, raw: false, mode: DEFAULT_SEARCH_MODE, json: false };
  if (cmd === "search") {
    if (args.length === 0) throw new Error("search requires a query");
    opts.query = args[0];
  }
  for (let i = cmd === "search" ? 1 : 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--prefix") opts.prefix = true;
    else if (arg === "--raw") { opts.raw = true; opts.mode = "raw"; }
    else if (arg === "--mode") {
      const raw = args[++i] ?? "";
      const mode = raw.toLowerCase();
      if (mode !== "auto" && mode !== "strict" && mode !== "broad" && mode !== "raw") throw new Error("--mode requires one of: auto, strict, broad, raw");
      opts.mode = mode; opts.raw = mode === "raw";
    } else if (arg === "--limit") {
      const raw = args[++i];
      if (!raw) throw new Error("--limit requires a number");
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--limit must be a positive number");
      opts.limit = Math.min(n, MAX_LIMIT);
    } else if (arg === "--folder") {
      opts.folder = args[++i] ?? "";
      if (!opts.folder) throw new Error("--folder requires a value");
    } else if (arg === "--tag") {
      opts.tag = args[++i] ?? "";
      if (!opts.tag) throw new Error("--tag requires a value");
    } else if (arg === "--type") {
      opts.type = args[++i] ?? "";
      if (!opts.type) throw new Error("--type requires a value");
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}
function printHumanResults(results: SearchResult[]): void {
  if (results.length === 0) { console.log("no matches"); return; }
  for (const result of results) {
    console.log(`${result.score.toFixed(3).padStart(8)}  ${result.path}`);
    console.log(`          ${result.snippet}`);
  }
}
export function main(argv = process.argv.slice(2)): number {
  try {
    const opts = parseArgs(argv);
    if (opts.cmd === "build" || opts.cmd === "update") {
      const result = updateIndex({ full: opts.cmd === "build", quiet: opts.json });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (opts.cmd === "status") { console.log(JSON.stringify(statusIndex(), null, 2)); return 0; }
    const results = searchIndex(opts.query, { limit: opts.limit, folder: opts.folder, tag: opts.tag,
      type: opts.type, prefix: opts.prefix, raw: opts.raw, mode: opts.mode });
    if (opts.json) console.log(JSON.stringify(results, null, 2)); else printHumanResults(results);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${message}`);
    if (message.startsWith("index not built yet")) console.error("Run: bun run tools/fts5/wiki-search.ts build");
    return 1;
  }
}
if (import.meta.main) process.exit(main());
