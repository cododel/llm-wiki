#!/usr/bin/env bun
/** Deterministic layer-aware wiki lint, extracted from the original tooling.
 * Reporting is read-only. Hash replacement requires explicit --fix-mechanical. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Glob } from "bun";
import { PACKAGING_DIRS, TOOL_ROOT, resolveWikiDir } from "./lib/paths.ts";
import { comparePathParts, fieldAsList, loadRecords, parseFrontmatter, parseTaxonomy as parseTagTaxonomy, validationReport, type ValidationReport } from "./wiki_tags.ts";
import { allowedSourceValue as healthAllowedSourceValue, checkBadSources, checkOutboundLinks } from "./wiki_health.ts";

const ROOT = resolveWikiDir();
const FACTCHECK_READOUT_RE = /^readouts\/\d{4}-\d{2}-\d{2}-factcheck.*\.md$/;
const ASSET_SUFFIXES = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".mp4", ".pdf"]);
const META_FILES = new Set(["AGENTS.md", "README.md", "SCHEMA.md", "index.md", "log.md"]);
const EXCLUDED_PATH_PARTS = new Set([".git", ".obsidian", ".hermes", ".claude", "_archive", "node_modules", "tools"]);
export type OversizedPage = { path: string; lines: number };
export type LintReport = {
  health_errors: string[]; health_warnings: string[]; missing_tags: string[];
  singleton_tags: Array<{ tag: string; count: number; category: string }>;
  missing_sha256: string[]; sha256_mismatches: string[]; unknown_tags: string[];
  raw_missing_type: string[]; raw_missing_source_kind: string[]; raw_bad_source_kind: string[];
  raw_missing_source_channel: string[]; raw_bad_source_channel: string[];
  raw_missing_source_tag: string[]; raw_metadata_tags_duplicated: string[];
  raw_missing_ingested: string[]; raw_missing_sha256: string[]; raw_bad_sha256: string[];
  raw_missing_processed_to: string[]; raw_processed_to_invalid: string[]; raw_web_missing_source_url: string[];
  oversized_pages: OversizedPage[]; asset_orphans: string[]; untracked_factcheck_readouts: string[];
  bad_sources: string[]; bad_wikilinks: string[]; low_outbound_links: string[];
  categories: Record<string, string[]>; malformed_frontmatter: string[];
};
const startsWithAny = (s: string, prefixes: string[]): boolean => prefixes.some((p) => s.startsWith(p));
const readText = (abs: string): string => readFileSync(abs, "utf8");
const isMeta = (rel: string): boolean => META_FILES.has(rel) || /^log-\d{4}-\d{2}-\d{2}\.md$/.test(rel);
function globSortedRel(pattern: string): string[] {
  const rels: string[] = [];
  for (const rel of new Glob(pattern).scanSync({ cwd: ROOT, dot: true, onlyFiles: true })) {
    const normalized = rel.split("\\").join("/"); const parts = normalized.split("/");
    if (parts.some((part) => EXCLUDED_PATH_PARTS.has(part)) || PACKAGING_DIRS.has(parts[0])) continue;
    rels.push(normalized);
  }
  return rels.sort(comparePathParts);
}
const allMdRel = (): string[] => globSortedRel("**/*.md");
const fileSuffix = (name: string): string => {
  const base = basename(name); const idx = base.lastIndexOf("."); return idx <= 0 ? "" : base.slice(idx);
};
export function isGeneratedFactcheckReadout(rel: string): boolean { return FACTCHECK_READOUT_RE.test(rel); }
export function classifyIssue(issue: string): string {
  const path = issue.split(":", 1)[0];
  if (isGeneratedFactcheckReadout(path)) return "generated_factcheck_artifact";
  if (startsWithAny(path, ["concepts/", "ideas/", "notes/", "entities/", "comparisons/", "queries/"])) return "content_graph";
  if (path.startsWith("readouts/")) return "dated_evidence";
  if (path.startsWith("raw/assets/") || issue.includes("asset orphan")) return "evidence_integrity";
  if (path.startsWith("raw/")) return "raw_source";
  if (path.startsWith(".factcheck") || path.startsWith(".hermes/")) return "ops_artifact";
  return "misc";
}
export function frontmatterBounds(text: string): [number, number] | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  return end === -1 ? null : [0, end + "\n---\n".length];
}
export function frontmatterText(text: string): string {
  const bounds = frontmatterBounds(text); return bounds === null ? "" : text.slice(4, bounds[1] - "\n---\n".length);
}
export function frontmatterFieldValues(text: string, field: string): string[] { return fieldAsList(parseFrontmatter(text).data[field]); }
export function bodyForHash(text: string): string {
  const bounds = frontmatterBounds(text); return bounds === null ? text : text.slice(bounds[1]);
}
const SHA256_LINE_RE = /^sha256:[ \t]*([a-fA-F0-9]{64})[ \t]*$/m;
export function rawSha256Issues(): { missing: string[]; mismatches: string[] } {
  const missing: string[] = []; const mismatches: string[] = [];
  // Integrity is checked by default; expensive audits may explicitly disable it.
  const checkMismatches = (process.env.WIKI_LINT_CHECK_SHA_MISMATCH ?? "1") === "1";
  if (!existsSync(join(ROOT, "raw"))) return { missing, mismatches };
  for (const rel of globSortedRel("raw/**/*.md")) {
    if (rel === "raw/_README.md") continue;
    const text = readText(join(ROOT, rel));
    const match = SHA256_LINE_RE.exec(frontmatterText(text));
    if (!match) { missing.push(rel); continue; }
    if (!checkMismatches) continue;
    const actual = createHash("sha256").update(bodyForHash(text), "utf8").digest("hex");
    if (match[1].toLowerCase() !== actual) mismatches.push(rel);
  }
  return { missing, mismatches };
}
/** Explicit source-revision operation: preserves the body byte-for-byte. */
export function recomputeSha256(absPath: string): boolean {
  const text = readText(absPath); const bounds = frontmatterBounds(text);
  if (!bounds) return false;
  const body = text.slice(bounds[1]);
  const actual = createHash("sha256").update(body, "utf8").digest("hex");
  const head = text.slice(0, bounds[1]);
  const newHead = head.replace(SHA256_LINE_RE, `sha256: ${actual}`);
  if (newHead === head) return false;
  writeFileSync(absPath, newHead + body); return true;
}
export function parseTaxonomy(): Set<string> { return new Set(parseTagTaxonomy(ROOT).keys()); }
export function parseTagsFromFrontmatter(text: string): Set<string> { return new Set(frontmatterFieldValues(text, "tags")); }
export function unknownTags(): string[] {
  const valid = parseTaxonomy(); const unknown = new Set<string>();
  for (const rel of allMdRel()) for (const tag of parseTagsFromFrontmatter(readText(join(ROOT, rel)))) if (!valid.has(tag)) unknown.add(tag);
  return [...unknown].sort();
}
export function untrackedFactcheckReadouts(): string[] {
  const proc = Bun.spawnSync(["git", "status", "--short", "readouts/*factcheck*.md"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return []; // A selected external vault need not be a Git checkout.
  return new TextDecoder().decode(proc.stdout).split("\n").filter((line) => line.startsWith("?? ")).map((line) => line.slice(3).trim());
}
export function allowedSourceValue(value: string): boolean { return healthAllowedSourceValue(value); }
export const WIKI_MD_PATH_RE = /(?<![\[\w])(concepts|ideas|entities|notes|comparisons|queries|drafts|pages|readouts|adr)\/(?:[A-Za-z0-9][-A-Za-z0-9_]*\/)*[A-Za-z0-9][-A-Za-z0-9_]*\.md(?![\]\w])/g;
export function badSources(): string[] {
  return allMdRel().filter((rel) => !isMeta(rel) && checkBadSources(rel, readText(join(ROOT, rel))) !== null);
}
export function badWikilinks(): string[] {
  const out: string[] = [];
  for (const rel of allMdRel()) {
    if (isMeta(rel) || rel.startsWith("raw/") || rel === ".factcheck-log.md") continue;
    let body = bodyForHash(readText(join(ROOT, rel))).replace(/```[\s\S]*?```/g, "");
    if (!isGeneratedFactcheckReadout(rel)) body = body.replace(/`[^`]+`/g, "");
    const matches = [...body.matchAll(WIKI_MD_PATH_RE)].map((m) => m[0]);
    if (matches.some((match) => existsSync(join(ROOT, match)))) out.push(rel);
  }
  return out;
}
export function lowOutboundLinks(): string[] {
  return allMdRel().filter((rel) => checkOutboundLinks(rel, readText(join(ROOT, rel))) !== null);
}
function splitlinesCount(text: string): number {
  if (!text) return 0;
  const parts = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (parts[parts.length - 1] === "") parts.pop(); return parts.length;
}
export function oversizedPages(limit = 200): OversizedPage[] {
  return allMdRel().filter((rel) => !isMeta(rel) && !rel.startsWith("raw/"))
    .map((path) => ({ path, lines: splitlinesCount(readText(join(ROOT, path))) }))
    .filter((item) => item.lines > limit).sort((a, b) => b.lines - a.lines);
}
export function assetOrphans(): string[] {
  if (!existsSync(join(ROOT, "raw", "assets"))) return [];
  // Asset wrappers in raw are valid provenance references; they need not be copied
  // into a processed page solely to satisfy a linter.
  const referencedText = allMdRel().map((rel) => readText(join(ROOT, rel))).join("\n");
  return globSortedRel("raw/assets/**/*").filter((rel) => ASSET_SUFFIXES.has(fileSuffix(rel).toLowerCase())
    && !referencedText.includes(rel) && !referencedText.includes(basename(rel)));
}
export function runHealth(): { errors: string[]; warnings: string[] } {
  const proc = Bun.spawnSync([process.execPath, "run", join(TOOL_ROOT, "tools", "wiki_health.ts"), "--json"], {
    cwd: ROOT, env: { ...process.env, WIKI_DIR: ROOT }, stdout: "pipe", stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  if (!stdout.trim()) throw new Error(`wiki_health.ts produced no JSON: ${new TextDecoder().decode(proc.stderr)}`);
  const data = JSON.parse(stdout) as { items: { errors: string[]; warnings: string[] } };
  return { errors: data.items.errors, warnings: data.items.warnings };
}
export function tagGovernanceReport(root: string = ROOT): ValidationReport {
  return validationReport(loadRecords(root), parseTagTaxonomy(root), root);
}
export function buildReport(): LintReport {
  const { errors, warnings } = runHealth(); const { missing, mismatches } = rawSha256Issues();
  const governance = tagGovernanceReport(ROOT);
  const unknownTagNames = [...new Set(governance.unknown_tags.map((item) => item.includes(": ") ? item.slice(item.indexOf(": ") + 2) : item))].sort();
  const categories: Record<string, string[]> = {};
  for (const issue of [...errors, ...warnings]) (categories[classifyIssue(issue)] ??= []).push(issue);
  return {
    health_errors: errors, health_warnings: warnings, missing_tags: governance.missing_tags, singleton_tags: governance.singleton_tags,
    missing_sha256: missing, sha256_mismatches: mismatches, unknown_tags: unknownTagNames,
    raw_missing_type: governance.raw_missing_type, raw_missing_source_kind: governance.raw_missing_source_kind,
    raw_bad_source_kind: governance.raw_bad_source_kind, raw_missing_source_channel: governance.raw_missing_source_channel,
    raw_bad_source_channel: governance.raw_bad_source_channel, raw_missing_source_tag: governance.raw_missing_source_tag,
    raw_metadata_tags_duplicated: governance.raw_metadata_tags_duplicated, raw_missing_ingested: governance.raw_missing_ingested,
    raw_missing_sha256: governance.raw_missing_sha256,
    raw_bad_sha256: [...governance.raw_bad_sha256_format, ...mismatches.map((rel) => `${rel}: sha256 mismatch`)],
    raw_missing_processed_to: governance.raw_missing_processed_to, raw_processed_to_invalid: governance.raw_bad_processed_to_format,
    raw_web_missing_source_url: governance.raw_web_missing_source_url, oversized_pages: oversizedPages(), asset_orphans: assetOrphans(),
    untracked_factcheck_readouts: untrackedFactcheckReadouts(), bad_sources: badSources(), bad_wikilinks: badWikilinks(),
    low_outbound_links: lowOutboundLinks(), categories, malformed_frontmatter: governance.malformed_frontmatter,
  };
}
const TITLES: Record<string, string> = {
  health_errors: "Health errors", health_warnings: "Health warnings", missing_tags: "Missing tags", singleton_tags: "Singleton tags",
  missing_sha256: "Missing SHA256", sha256_mismatches: "SHA256 mismatches", unknown_tags: "Unknown tags",
  raw_missing_type: "Raw missing type", raw_missing_source_kind: "Raw missing source kind", raw_bad_source_kind: "Raw bad source kind",
  raw_missing_source_channel: "Raw missing source channel", raw_bad_source_channel: "Raw bad source channel",
  raw_missing_source_tag: "Raw missing source tag", raw_metadata_tags_duplicated: "Raw metadata duplicated as tags",
  raw_missing_ingested: "Raw missing ingested", raw_missing_sha256: "Raw missing SHA256", raw_bad_sha256: "Raw bad SHA256",
  raw_missing_processed_to: "Raw missing processed_to", raw_processed_to_invalid: "Raw processed_to invalid",
  raw_web_missing_source_url: "Raw web missing source_url", oversized_pages: "Oversized pages", asset_orphans: "Asset evidence gaps",
  untracked_factcheck_readouts: "Untracked factcheck readouts", bad_sources: "Bad sources (wiki paths)",
  bad_wikilinks: "Bad wikilinks (bare .md paths)", low_outbound_links: "Low outbound links", malformed_frontmatter: "Malformed frontmatter",
};
export function markdown(report: LintReport): string {
  const lines = ["# Wiki weekly lint", "", "Deterministic layer-aware report for the selected WIKI_DIR.", "", "## Summary", "", "| Category | Count |", "|---|---:|"];
  for (const [key, value] of Object.entries(report)) if (Array.isArray(value)) lines.push(`| ${TITLES[key] ?? key} | ${value.length} |`);
  for (const [key, value] of Object.entries(report)) {
    if (!Array.isArray(value)) continue;
    lines.push("", `## ${TITLES[key] ?? key} (${value.length})`, "");
    if (!value.length) { lines.push("_None._"); continue; }
    for (const item of value) {
      if (typeof item === "string") lines.push(`- \`${item}\``);
      else lines.push(`- ${Object.entries(item).map(([field, detail]) => `${field}=${detail}`).join(", ")}`);
    }
  }
  for (const [key, items] of Object.entries(report.categories)) lines.push("", `## ${key} (${items.length})`, "", ...items.map((item) => `- ${item}`));
  return lines.join("\n") + "\n";
}
export function applyMechanicalFixes(report: LintReport): string[] {
  const changed: string[] = [];
  for (const rel of report.sha256_mismatches) if (recomputeSha256(join(ROOT, rel))) changed.push(rel);
  return changed;
}
export function hasActionableIssues(report: LintReport): boolean {
  const informational = new Set(["health_warnings", "singleton_tags", "oversized_pages", "low_outbound_links"]);
  return Object.entries(report).some(([key, value]) => !informational.has(key) && Array.isArray(value) && value.length > 0);
}
export function main(argv: string[]): number {
  const fix = argv.includes("--fix-mechanical");
  if (fix && !argv.includes("--accept-source-revision")) {
    console.error("Hash drift is evidence. Review the changed source, then use --fix-mechanical --accept-source-revision only for an approved revision; log the decision.");
    return 2;
  }
  let report = buildReport(); const changed = fix ? applyMechanicalFixes(report) : [];
  if (changed.length) report = buildReport();
  if (argv.includes("--json")) console.log(JSON.stringify({ ...report, mechanical_fixes_applied: changed }, null, 2));
  else console.log(markdown(report) + (changed.length ? `\n## Mechanical fixes applied\n${changed.join("\n")}\n` : ""));
  return hasActionableIssues(report) || (argv.includes("--strict") && report.health_warnings.length > 0) ? 1 : 0;
}
if (import.meta.main) process.exit(main(process.argv.slice(2)));
