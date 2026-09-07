#!/usr/bin/env bun
// Deterministic, read-only tag governance extracted from the source wiki.
// Parses local Markdown and SCHEMA taxonomy; never calls a model or the network.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { Glob } from "bun";
import { PACKAGING_DIRS, resolveWikiDir } from "./lib/paths.ts";

const DEFAULT_ROOT = resolveWikiDir();
const EXCLUDED_DIRS = new Set([".git", ".obsidian", ".hermes", ".claude", "_archive", "node_modules", "tools"]);
const ALLOWED_SOURCE_KINDS = new Set(["user-note", "chat", "transcript", "doc", "article", "asset-note", "log"]);
const ALLOWED_SOURCE_CHANNELS = new Set(["telegram", "web", "file", "manual", "import"]);
const SHA256_RE = /^[a-fA-F0-9]{64}$/;
const TYPE_REQUIRED_TAGS: Record<string, Set<string>> = {
  idea: new Set(["idea"]), note: new Set(["thought", "learning"]),
  "post-draft": new Set(["content"]), "article-draft": new Set(["content"]),
  readout: new Set(["readout"]), comparison: new Set(["comparison"]),
  query: new Set(["summary"]), "raw-source": new Set(["source"]), adr: new Set(["adr"]),
};

function stripChars(s: string, chars: string): string {
  let a = 0; let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
const stripQuotes = (s: string): string => stripChars(s, "\"'");
function csvSplit(value: string): string[] {
  const fields: string[] = [];
  let cur = ""; let inQuotes = false; let atFieldStart = true;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes) {
      if (ch === '"') {
        if (value[i + 1] === '"') { cur += '"'; i++; continue; }
        inQuotes = false; continue;
      }
      cur += ch; continue;
    }
    if (atFieldStart && ch === " ") continue;
    if (ch === '"') { inQuotes = true; atFieldStart = false; continue; }
    if (ch === ",") { fields.push(cur); cur = ""; atFieldStart = true; continue; }
    cur += ch; atFieldStart = false;
  }
  fields.push(cur);
  return fields.filter((field) => field.trim() !== "").map((field) => stripQuotes(field.trim()));
}
function parseInlineValue(rest: string): string | string[] {
  const r = rest.trim();
  if (r === "") return "";
  if (r === "[]") return [];
  if (r.startsWith("[") && r.endsWith("]")) return csvSplit(r.slice(1, -1));
  return stripQuotes(r);
}
export interface FrontmatterResult {
  status: "ok" | "absent" | "malformed";
  data: Record<string, string | string[]>;
  block: string;
  body: string;
}
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;
export function parseFrontmatter(text: string): FrontmatterResult {
  if (!text.startsWith("---\n")) return { status: "absent", data: {}, block: "", body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { status: "malformed", data: {}, block: text.slice(4), body: "" };
  const block = text.slice(4, end);
  const body = text.slice(end + "\n---\n".length);
  const lines = block.split(/\r\n|\r|\n/);
  const data: Record<string, string | string[]> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.startsWith(" ") || line.startsWith("\t") || line.startsWith("#")) { i++; continue; }
    const match = KEY_RE.exec(line);
    if (!match) return { status: "malformed", data: {}, block, body };
    const key = match[1]; const rest = match[2];
    if (Object.hasOwn(data, key)) return { status: "malformed", data: {}, block, body };
    if (rest.trim()) {
      const strippedRest = rest.trim();
      const quoted = strippedRest.length >= 2 && (strippedRest[0] === "'" || strippedRest[0] === '"') && strippedRest[strippedRest.length - 1] === strippedRest[0];
      if (strippedRest.includes(": ") && !quoted) return { status: "malformed", data: {}, block, body };
      data[key] = parseInlineValue(rest); i++; continue;
    }
    const children: string[] = [];
    i++;
    while (i < lines.length) {
      const child = lines[i];
      if (child && !(child.startsWith(" ") || child.startsWith("\t"))) break;
      const stripped = child.trim();
      if (stripped.startsWith("- ")) children.push(stripQuotes(stripped.slice(2).trim()));
      i++;
    }
    data[key] = children;
  }
  return { status: "ok", data, block, body };
}
export function fieldAsList(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter((item) => item !== "");
  if (typeof value === "string") {
    const stripped = value.trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) return csvSplit(stripped.slice(1, -1));
    return stripped.split(",").filter((item) => item.trim() !== "").map((item) => stripQuotes(item.trim()));
  }
  return [String(value).trim()];
}
function scalar(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
export class PageRecord {
  constructor(readonly path: string, readonly rel: string, readonly frontmatter: FrontmatterResult) {}
  get hasFrontmatter(): boolean { return this.frontmatter.status === "ok"; }
  get type(): string | null {
    const value = this.frontmatter.data["type"];
    return typeof value === "string" && value ? value : null;
  }
  get tags(): string[] { return fieldAsList(this.frontmatter.data["tags"]); }
  get folder(): string { const parent = dirname(this.rel); return parent === "." ? "" : parent; }
}
export function comparePathParts(a: string, b: string): number {
  const pa = a.split("/"); const pb = b.split("/"); const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) { if (pa[i] < pb[i]) return -1; if (pa[i] > pb[i]) return 1; }
  return pa.length - pb.length;
}
export function iterMarkdownFiles(root: string): string[] {
  const glob = new Glob("**/*.md"); const rels: string[] = [];
  for (const rel of glob.scanSync({ cwd: root, dot: true, onlyFiles: true })) {
    const normalized = rel.split("\\").join("/"); const parts = normalized.split("/");
    if (parts.some((part) => EXCLUDED_DIRS.has(part)) || PACKAGING_DIRS.has(parts[0])) continue;
    rels.push(normalized);
  }
  return rels.sort(comparePathParts);
}
export function loadRecords(root: string): PageRecord[] {
  return iterMarkdownFiles(root).map((rel) => {
    const abs = join(root, rel);
    return new PageRecord(abs, rel, parseFrontmatter(readFileSync(abs, "utf8")));
  });
}
export function parseTaxonomy(root: string): Map<string, string> {
  const schema = join(root, "SCHEMA.md");
  if (!existsSync(schema)) return new Map();
  const tagToCategory = new Map<string, string>();
  let currentCategory = "Uncategorized"; let inTaxonomy = false;
  for (const line of readFileSync(schema, "utf8").split(/\r\n|\r|\n/)) {
    const stripped = line.trim();
    if (stripped === "## Tag Taxonomy") { inTaxonomy = true; continue; }
    if (!inTaxonomy) continue;
    if (stripped.startsWith("## ")) break;
    if (stripped.startsWith("Rule:") || stripped.startsWith("### Tag Governance") || stripped.startsWith("### Type-to-Tag")) break;
    if (stripped.startsWith("### ")) { currentCategory = stripped.slice(4).trim(); continue; }
    if (!stripped.startsWith("- ")) continue;
    const tagList = stripped.slice(2).trim();
    if (!tagList || tagList.startsWith("(")) continue;
    for (const tag of csvSplit(tagList)) {
      const clean = stripChars(tag.trim(), "`");
      if (clean) tagToCategory.set(clean, currentCategory);
    }
  }
  return tagToCategory;
}
type Counter = Map<string, number>;
function normalizeFolder(folder: string | null | undefined): string | null { return folder ? stripChars(folder.trim(), "/") : null; }
function recordMatches(record: PageRecord, folder?: string | null, pageType?: string | null): boolean {
  const normalizedFolder = normalizeFolder(folder);
  if (normalizedFolder) {
    const rel = stripChars(record.rel, "/");
    if (rel !== normalizedFolder && !rel.startsWith(normalizedFolder + "/")) return false;
  }
  return !pageType || record.type === pageType;
}
export function tagCounts(records: PageRecord[], folder?: string | null, pageType?: string | null): Counter {
  const counts: Counter = new Map();
  for (const record of records) {
    if (!recordMatches(record, folder, pageType)) continue;
    for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}
export function sortedCounts(counts: Counter): Array<[string, number]> { return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); }
export function pagesForTag(records: PageRecord[], tag: string): string[] { return records.filter((record) => record.tags.includes(tag)).map((record) => record.rel).sort(); }
function rawMetadataTagExclusions(record: PageRecord): Set<string> {
  if (record.type !== "raw-source") return new Set();
  const fm = record.frontmatter.data; const out = new Set<string>();
  for (const value of [scalar(fm["source_kind"]), scalar(fm["source_channel"])]) if (value) out.add(value);
  return out;
}
function headings(body: string): string[] {
  return body.split(/\r\n|\r|\n/).filter((line) => line.startsWith("#")).map((line) => line.replace(/^#+/, "").trim());
}
function tokenSet(text: string): Set<string> { return new Set(text.toLowerCase().match(/[A-Za-zА-Яа-я0-9]+/g) ?? []); }
export interface Suggestion {
  tag: string; category: string; score: number; global_count: number;
  same_folder_count: number; same_type_count: number; reasons: string[];
}
export function suggestTags(record: PageRecord, records: PageRecord[], tagToCategory: Map<string, string>): Suggestion[] {
  const validTags = [...tagToCategory.keys()];
  if (validTags.length === 0) return [];
  const globalCounts = tagCounts(records);
  const sameFolderCounts = record.folder ? tagCounts(records, record.folder) : new Map<string, number>();
  const sameTypeCounts = record.type ? tagCounts(records, null, record.type) : new Map<string, number>();
  const currentTags = new Set(record.tags);
  const title = scalar(record.frontmatter.data["title"]);
  const context = [record.rel, record.folder, record.type ?? "", title,
    headings(record.frontmatter.body).join("\n"), record.frontmatter.body.slice(0, 4000)].join("\n").toLowerCase();
  const tokens = tokenSet(context); const metadataTagExclusions = rawMetadataTagExclusions(record);
  const suggestions: Suggestion[] = [];
  for (const tag of [...validTags].sort()) {
    if (currentTags.has(tag) || metadataTagExclusions.has(tag)) continue;
    let score = 0; const reasons: string[] = [];
    const required = TYPE_REQUIRED_TAGS[record.type ?? ""] ?? new Set<string>();
    if (required.has(tag)) { score += 8; reasons.push(`required for type=${record.type}`); }
    const tagPhrase = tag.replace(/-/g, " ").toLowerCase();
    const tagTokens = new Set(tagPhrase.split(" ").filter((t) => t !== ""));
    if (context.includes(tag) || context.includes(tagPhrase)) { score += 5; reasons.push("tag text appears in file context"); }
    else if (tagTokens.size && [...tagTokens].every((t) => tokens.has(t))) { score += 3; reasons.push("all tag tokens appear in file context"); }
    else if (tagTokens.size && [...tagTokens].some((t) => tokens.has(t))) { score += 1; reasons.push("some tag tokens appear in file context"); }
    const folderCount = sameFolderCounts.get(tag);
    if (folderCount) { score += Math.min(3, folderCount); reasons.push(`used ${folderCount} time(s) in same folder`); }
    const typeCount = sameTypeCounts.get(tag);
    if (typeCount) { score += Math.min(3, typeCount); reasons.push(`used ${typeCount} time(s) on same type`); }
    if (score <= 0) continue;
    suggestions.push({ tag, category: tagToCategory.get(tag) ?? "", score, global_count: globalCounts.get(tag) ?? 0,
      same_folder_count: sameFolderCounts.get(tag) ?? 0, same_type_count: sameTypeCounts.get(tag) ?? 0, reasons });
  }
  return suggestions.sort((a, b) => b.score - a.score || b.global_count - a.global_count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)).slice(0, 20);
}
export interface ValidationReport {
  summary: Record<string, number>;
  absent_frontmatter: string[]; malformed_frontmatter: string[];
  missing_tags: string[]; missing_type_required_tags: string[]; unknown_tags: string[];
  singleton_tags: Array<{ tag: string; count: number; category: string }>;
  raw_missing_type: string[]; raw_missing_source_kind: string[]; raw_bad_source_kind: string[];
  raw_missing_source_channel: string[]; raw_bad_source_channel: string[]; raw_missing_ingested: string[];
  raw_missing_sha256: string[]; raw_bad_sha256_format: string[]; raw_missing_processed_to: string[];
  raw_bad_processed_to_format: string[]; raw_missing_source_tag: string[];
  raw_metadata_tags_duplicated: string[]; raw_web_missing_source_url: string[];
}
export function validProcessedToTarget(target: string, root: string): boolean {
  if (!target) return true;
  if (target.endsWith(".md") || target.includes("[[") || target.includes("]]")) return false;
  if (target.includes("\\") || target.includes(":") || target.startsWith("/") || target.startsWith("raw/") || target.startsWith("./") || target.startsWith("../") || posix.normalize(target) !== target) return false;
  if (PACKAGING_DIRS.has(target.split("/")[0]) || target.startsWith("_archive/")) return false;
  const candidate = join(root, `${target}.md`);
  if (!existsSync(candidate)) return false;
  try {
    const rel = relative(realpathSync(root), realpathSync(candidate));
    return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && statSync(candidate).isFile();
  } catch { return false; }
}
export function validationReport(records: PageRecord[], tagToCategory: Map<string, string>, root: string): ValidationReport {
  const validTags = new Set(tagToCategory.keys()); const counts = tagCounts(records);
  const report: ValidationReport = {
    summary: { markdown_files: records.length, frontmatter_ok: records.filter((r) => r.frontmatter.status === "ok").length,
      frontmatter_absent: records.filter((r) => r.frontmatter.status === "absent").length,
      frontmatter_malformed: records.filter((r) => r.frontmatter.status === "malformed").length,
      schema_tags: validTags.size, used_tags: counts.size },
    absent_frontmatter: records.filter((r) => r.frontmatter.status === "absent").map((r) => r.rel).sort(),
    malformed_frontmatter: records.filter((r) => r.frontmatter.status === "malformed").map((r) => r.rel).sort(),
    missing_tags: [], missing_type_required_tags: [], unknown_tags: [], singleton_tags: [],
    raw_missing_type: [], raw_missing_source_kind: [], raw_bad_source_kind: [],
    raw_missing_source_channel: [], raw_bad_source_channel: [], raw_missing_ingested: [],
    raw_missing_sha256: [], raw_bad_sha256_format: [], raw_missing_processed_to: [],
    raw_bad_processed_to_format: [], raw_missing_source_tag: [], raw_metadata_tags_duplicated: [], raw_web_missing_source_url: [],
  };
  const unknownByPage: string[] = [];
  for (const record of records) {
    if (record.frontmatter.status !== "ok") continue;
    const tags = record.tags;
    if (tags.length === 0) report.missing_tags.push(record.rel);
    const requiredTags = TYPE_REQUIRED_TAGS[record.type ?? ""];
    if (requiredTags && !tags.some((t) => requiredTags.has(t))) report.missing_type_required_tags.push(`${record.rel}: type=${record.type} requires one of ${[...requiredTags].sort().join(", ")}`);
    for (const tag of tags) if (!validTags.has(tag)) unknownByPage.push(`${record.rel}: ${tag}`);
    if (!record.rel.startsWith("raw/") || record.rel === "raw/_README.md") continue;
    const fm = record.frontmatter.data;
    const pageType = scalar(fm["type"]); const sourceKind = scalar(fm["source_kind"]);
    const sourceChannel = scalar(fm["source_channel"]); const ingested = scalar(fm["ingested"]);
    const sha256 = scalar(fm["sha256"]); const processedTo = fm["processed_to"];
    if (pageType !== "raw-source") report.raw_missing_type.push(record.rel);
    if (!sourceKind) report.raw_missing_source_kind.push(record.rel);
    else if (!ALLOWED_SOURCE_KINDS.has(sourceKind)) report.raw_bad_source_kind.push(`${record.rel}: ${sourceKind}`);
    if (!sourceChannel) report.raw_missing_source_channel.push(record.rel);
    else if (!ALLOWED_SOURCE_CHANNELS.has(sourceChannel)) report.raw_bad_source_channel.push(`${record.rel}: ${sourceChannel}`);
    if (!ingested) report.raw_missing_ingested.push(record.rel);
    if (!sha256) report.raw_missing_sha256.push(record.rel);
    else if (!SHA256_RE.test(sha256)) report.raw_bad_sha256_format.push(`${record.rel}: ${sha256}`);
    if (processedTo === undefined) report.raw_missing_processed_to.push(record.rel);
    else for (const target of fieldAsList(processedTo)) if (!validProcessedToTarget(target, root)) report.raw_bad_processed_to_format.push(`${record.rel}: ${target}`);
    if (pageType === "raw-source" && !tags.includes("source")) report.raw_missing_source_tag.push(record.rel);
    for (const duplicated of [...new Set(tags.filter((tag) => tag === sourceKind || tag === sourceChannel))].sort()) if (duplicated) report.raw_metadata_tags_duplicated.push(`${record.rel}: ${duplicated}`);
    if (sourceChannel === "web" && !scalar(fm["source_url"])) report.raw_web_missing_source_url.push(record.rel);
  }
  report.unknown_tags = unknownByPage.sort();
  report.singleton_tags = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .filter(([, count]) => count === 1).map(([tag, count]) => ({ tag, count, category: tagToCategory.get(tag) ?? "" }));
  return report;
}
const BLOCKING_KEYS: Array<keyof ValidationReport> = [
  "malformed_frontmatter", "missing_tags", "missing_type_required_tags", "unknown_tags", "raw_missing_type",
  "raw_missing_source_kind", "raw_bad_source_kind", "raw_missing_source_channel", "raw_bad_source_channel",
  "raw_missing_ingested", "raw_missing_sha256", "raw_bad_sha256_format", "raw_missing_processed_to",
  "raw_bad_processed_to_format", "raw_missing_source_tag", "raw_metadata_tags_duplicated", "raw_web_missing_source_url",
];
export function validationHasBlockingIssues(report: ValidationReport): boolean {
  return BLOCKING_KEYS.some((key) => { const value = report[key]; return Array.isArray(value) && value.length > 0; });
}
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>; const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeysDeep(source[key]);
    return out;
  }
  return value;
}
function stableJson(value: unknown): string { return JSON.stringify(sortKeysDeep(value), null, 2); }
function pyRepr(value: string): string {
  if (value.includes("'") && !value.includes('"')) return `"${value}"`;
  return `'${value.replace(/'/g, "\\'")}'`;
}
export function renderCounts(counts: Counter, tagToCategory: Map<string, string>, asJson: boolean): string {
  const rows = sortedCounts(counts).map(([tag, count]) => ({ tag, count, category: tagToCategory.get(tag) ?? "" }));
  if (asJson) return stableJson(rows) + "\n";
  return "count\ttag\tcategory\n" + rows.map((row) => `${row.count}\t${row.tag}\t${row.category}\n`).join("");
}
export function renderShow(tag: string, pages: string[], asJson: boolean): string {
  if (asJson) return stableJson({ tag, count: pages.length, pages }) + "\n";
  return `# Pages tagged ${pyRepr(tag)} (${pages.length})\n` + pages.map((page) => `${page}\n`).join("");
}
export function renderSuggest(record: PageRecord, records: PageRecord[], tagToCategory: Map<string, string>, asJson: boolean): string {
  const globalCounts = tagCounts(records);
  const sameFolderCounts = record.folder ? tagCounts(records, record.folder) : new Map<string, number>();
  const sameTypeCounts = record.type ? tagCounts(records, null, record.type) : new Map<string, number>();
  const suggestions = suggestTags(record, records, tagToCategory);
  const topRows = (counts: Counter): Array<{ tag: string; count: number; category: string }> => sortedCounts(counts).slice(0, 20).map(([tag, count]) => ({ tag, count, category: tagToCategory.get(tag) ?? "" }));
  const typeRequired: Record<string, string[]> = {};
  for (const key of Object.keys(TYPE_REQUIRED_TAGS).sort()) typeRequired[key] = [...TYPE_REQUIRED_TAGS[key]].sort();
  const current = { type: record.type, folder: record.folder, tags: record.tags, title: scalar(record.frontmatter.data["title"]),
    source_kind: scalar(record.frontmatter.data["source_kind"]), source_channel: scalar(record.frontmatter.data["source_channel"]) };
  const payload = {
    file: record.rel, frontmatter_status: record.frontmatter.status, current, nearest_existing_tags: suggestions,
    global_top_tags: topRows(globalCounts), same_folder_top_tags: topRows(sameFolderCounts), same_type_top_tags: topRows(sameTypeCounts),
    schema_hints: { valid_tag_count: tagToCategory.size, type_required_tags: typeRequired,
      raw_source_policy: { source_tag_required: true, source_kind_values: [...ALLOWED_SOURCE_KINDS].sort(),
        source_channel_values: [...ALLOWED_SOURCE_CHANNELS].sort(), metadata_values_not_suggested_for_this_file: [...rawMetadataTagExclusions(record)].sort(),
        rule: "For raw-source files, do not duplicate that file's own source_kind/source_channel as tags; non-raw pages may use channel terms such as telegram when they are semantic SCHEMA tags." },
      new_tag_policy: "Prefer existing schema tags. Add a new tag only for a durable reusable semantic facet or a core domain; do not tag dates, statuses, source forms/channels, or one-off proper nouns." },
  };
  if (asJson) return stableJson(payload) + "\n";
  let out = `# Tag suggestion context for ${record.rel}\nfrontmatter_status: ${record.frontmatter.status}\ntype: ${current.type || "-"}\nfolder: ${current.folder || "."}\ncurrent_tags: ${current.tags.length ? current.tags.join(", ") : "-"}\n`;
  if (current.source_kind || current.source_channel) out += `source_kind/source_channel: ${current.source_kind || "-"} / ${current.source_channel || "-"}\n`;
  out += "\n## Nearest existing tags\n";
  if (suggestions.length === 0) out += "_None found deterministically._\n";
  for (const item of suggestions) out += `- ${item.tag} (${item.category}), score=${item.score}, global=${item.global_count} — ${item.reasons.join("; ")}\n`;
  const printCounts = (title: string, rows: Array<{ tag: string; count: number; category: string }>): void => {
    out += `\n## ${title}\n`;
    if (rows.length === 0) { out += "_None._\n"; return; }
    for (const row of rows.slice(0, 15)) out += `- ${row.tag}: ${row.count} (${row.category})\n`;
  };
  printCounts("Global top tags", payload.global_top_tags); printCounts("Same-folder top tags", payload.same_folder_top_tags); printCounts("Same-type top tags", payload.same_type_top_tags);
  out += "\n## Schema hints\n- Raw sources require tag `source` plus semantic tags from SCHEMA.md.\n- For raw sources, do not duplicate that file's own source_kind/source_channel as tags.\n- Non-raw pages may use channel terms when they are semantic SCHEMA tags.\n- Do not turn date/status/proper-noun metadata into tags.\n- Add new tags only after taxonomy expansion in SCHEMA.md.\n";
  return out;
}
const VALIDATE_SECTIONS: Array<keyof ValidationReport> = ["absent_frontmatter", ...BLOCKING_KEYS.slice(0, 4), "singleton_tags", ...BLOCKING_KEYS.slice(4)];
export function renderValidate(report: ValidationReport, asJson: boolean): string {
  if (asJson) return stableJson(report) + "\n";
  let out = "# Wiki tag validation\n\n## Summary\n";
  for (const [key, value] of Object.entries(report.summary)) out += `- ${key}: ${value}\n`;
  for (const key of VALIDATE_SECTIONS) {
    const items = report[key] as Array<string | { tag: string; count: number; category: string }>;
    out += `\n## ${key} (${items.length})\n`;
    if (items.length === 0) { out += "_None._\n"; continue; }
    for (const item of items) out += typeof item === "object" ? "- " + Object.entries(item).map(([k, v]) => `${k}=${v}`).join(", ") + "\n" : `- ${item}\n`;
  }
  return out;
}
export function findRecord(records: PageRecord[], fileArg: string, root: string): PageRecord | null {
  let rel: string;
  if (fileArg.startsWith("/")) {
    const resolved = resolve(fileArg); const rootResolved = resolve(root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + "/")) return null;
    rel = resolved === rootResolved ? "" : resolved.slice(rootResolved.length + 1);
  } else rel = stripChars(fileArg, "/");
  return records.find((record) => record.rel === rel) ?? null;
}
function getOption(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
  return undefined;
}
function hasFlag(args: string[], name: string): boolean { return args.includes(name); }
export function main(argv: string[]): number {
  let root = DEFAULT_ROOT; const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") {
      const value = argv[++i];
      if (!value) { process.stderr.write("--root requires a path\n"); return 2; }
      root = value; continue;
    }
    if (argv[i].startsWith("--root=")) { root = argv[i].slice("--root=".length); continue; }
    rest.push(argv[i]);
  }
  root = resolve(root);
  const command = rest.shift();
  if (!command) { process.stderr.write("usage: wiki_tags.ts [--root ROOT] {counts,show,suggest,validate} ...\n"); return 2; }
  const args = rest;
  if (command === "counts") {
    const records = loadRecords(root); const tagToCategory = parseTaxonomy(root);
    process.stdout.write(renderCounts(tagCounts(records, getOption(args, "--folder"), getOption(args, "--type")), tagToCategory, hasFlag(args, "--json"))); return 0;
  }
  if (command === "show") {
    const tag = getOption(args, "--tag");
    if (tag === undefined) { process.stderr.write("show: --tag is required\n"); return 2; }
    process.stdout.write(renderShow(tag, pagesForTag(loadRecords(root), tag), hasFlag(args, "--json"))); return 0;
  }
  if (command === "suggest") {
    const file = getOption(args, "--file");
    if (file === undefined) { process.stderr.write("suggest: --file is required\n"); return 2; }
    const records = loadRecords(root); const tagToCategory = parseTaxonomy(root); const record = findRecord(records, file, root);
    if (record === null) { process.stderr.write(`File not found under wiki root: ${file}\n`); return 2; }
    process.stdout.write(renderSuggest(record, records, tagToCategory, hasFlag(args, "--json"))); return 0;
  }
  if (command === "validate") {
    const report = validationReport(loadRecords(root), parseTaxonomy(root), root);
    process.stdout.write(renderValidate(report, hasFlag(args, "--json")));
    return hasFlag(args, "--strict") && validationHasBlockingIssues(report) ? 1 : 0;
  }
  process.stderr.write(`unknown command: ${command}\n`); return 2;
}
if (import.meta.main) process.exit(main(process.argv.slice(2)));
