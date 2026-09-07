#!/usr/bin/env bun
/** Structural validator extracted from the wiki: metadata, links, provenance,
 * index coverage, source preservation, collisions, and orphan detection. */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { Glob } from "bun";
import { PACKAGING_DIRS, resolveWikiDir } from "./lib/paths.ts";
import { fieldAsList, parseFrontmatter, parseTaxonomy as taxonomyMap } from "./wiki_tags.ts";

const ROOT = resolveWikiDir();
const SKIP_DIRS = new Set([".git", ".obsidian", ".claude", ".hermes", "node_modules", "__pycache__"]);
const SKIP_FILES = new Set([".factcheck-log.md"]);
const FACTCHECK_READOUT_RE = /^readouts\/\d{4}-\d{2}-\d{2}-factcheck-[^/]+(?:-batch-\d+|-summary)\.md$/;
const FM_EXEMPT = new Set(["AGENTS.md", "README.md", "SCHEMA.md", "index.md", "log.md", "raw/_README.md"]);
export const VALID_TYPES = new Set(["raw-source", "readout", "entity", "concept", "comparison", "query", "idea", "note", "article-draft", "post-draft", "meta", "adr"]);
const TEMPLATE_TARGETS = new Set([
  "idea-name", "idea-name/README", "idea-name/product", "idea-name/tech", "concept-name", "concept-slug",
  "page-name", "page-1", "page-2", "ideas/project-slug", "./sub-page", "wikilinks", "path", "SCHEMA.md",
  "ideas/example/README", "./detail", "./topic", "./README", "ideas/example",
]);
const TEMPLATE_SOURCES = new Set(["SCHEMA.md", "AGENTS.md", "adr/README.md", "pages/workflows.md", "readouts/README.md"]);
const META_PATHS = new Set([
  "index.md", "log.md", "SCHEMA.md", "AGENTS.md", "README.md", "pages/overview.md", "pages/workflows.md",
  "pages/open-questions.md", "raw/_README.md", "readouts/README.md", "drafts/README.md",
  "drafts/articles/README.md", "drafts/posts/README.md", "adr/README.md",
]);
const isDatedLog = (rel: string): boolean => /^log-\d{4}-\d{2}-\d{2}\.md$/.test(rel);
const isAgentContract = (rel: string): boolean => ["AGENTS.md", "CLAUDE.md"].includes(basename(rel));
const isPackaging = (rel: string): boolean => PACKAGING_DIRS.has(rel.split("/")[0]);
const startsWithAny = (s: string, prefixes: string[]): boolean => prefixes.some((p) => s.startsWith(p));
const matchAllGroup1 = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1]);

export function isGeneratedFactcheckReadout(rel: string): boolean { return FACTCHECK_READOUT_RE.test(rel); }
export function isIndexExempt(rel: string): boolean {
  return META_PATHS.has(rel) || isDatedLog(rel) || isPackaging(rel)
    || startsWithAny(rel, ["_archive/", ".hermes/", "raw/", "readouts/"])
    || isGeneratedFactcheckReadout(rel);
}
export function isOrphanExempt(rel: string): boolean {
  return META_PATHS.has(rel) || isDatedLog(rel) || isPackaging(rel) || isAgentContract(rel)
    || startsWithAny(rel, ["raw/", "_archive/", ".hermes/", "readouts/"])
    || basename(rel) === "README.md";
}
function stripExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx <= 0 ? name : name.slice(0, idx);
}
function fileSuffix(rel: string): string {
  const base = basename(rel); const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx);
}
function globSorted(pattern: string): string[] {
  return [...new Glob(pattern).scanSync({ cwd: ROOT, dot: true, onlyFiles: true })].map((rel) => rel.split("\\").join("/")).sort();
}
function included(rel: string): boolean {
  return !SKIP_FILES.has(rel) && !isPackaging(rel) && !rel.split("/").some((part) => SKIP_DIRS.has(part));
}
export function mdFiles(): string[] { return globSorted("**/*.md").filter(included); }
export function allWikiFiles(): string[] {
  const files = new Set(mdFiles());
  for (const ext of ["log", "txt", "jpg", "jpeg", "png", "gif", "webp", "svg", "mp4", "pdf", "py", "ts"]) {
    for (const rel of globSorted(`**/*.${ext}`)) if (included(rel)) files.add(rel);
  }
  return [...files].sort();
}
function readText(rel: string): string { return readFileSync(join(ROOT, rel), "utf8"); }
export function frontmatter(text: string): Record<string, string> {
  const parsed = parseFrontmatter(text);
  const out: Record<string, string> = {};
  if (parsed.status !== "ok") return out;
  for (const [key, value] of Object.entries(parsed.data)) out[key] = Array.isArray(value) ? `[${value.join(", ")}]` : value;
  return out;
}
export function frontmatterFieldValues(text: string, field: string): string[] {
  return fieldAsList(parseFrontmatter(text).data[field]);
}
export function allowedSourceValue(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (/^https?:\/\//.test(v)) return true;
  return v.startsWith("raw/") && !v.includes("\\") && posix.normalize(v) === v;
}
const ABSOLUTE_FILESYSTEM_PATH_RE = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/;
const isAbsoluteFilesystemPath = (value: string): boolean => ABSOLUTE_FILESYSTEM_PATH_RE.test(value.trim());

export type ResolveResult = string | null | "ambiguous";
export type Collision = { stem: string; files: string[] };
/** Explicit vault/relative paths, unique suffix/stem; no folder-to-README guess. */
export function buildResolver(files: string[]): {
  resolve: (target: string, sourcePath?: string) => ResolveResult;
  getCollisions: () => Collision[];
} {
  const suffixIndex = new Map<string, string[]>();
  const stemIndex = new Map<string, string[]>();
  const exactPathIndex = new Map<string, string>();
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const arr = map.get(key); if (arr) arr.push(value); else map.set(key, [value]);
  };
  for (const f of new Set(files)) {
    const relNoExt = stripExt(f);
    exactPathIndex.set(relNoExt, f);
    if (!f.endsWith(".md")) exactPathIndex.set(f, f);
    const parts = relNoExt.split("/");
    for (let i = 0; i < parts.length; i++) push(suffixIndex, parts.slice(i).join("/"), f);
    push(stemIndex, stripExt(basename(f)), f);
    if (fileSuffix(f) && fileSuffix(f) !== ".md") {
      const extParts = f.split("/");
      for (let i = 0; i < extParts.length; i++) push(suffixIndex, extParts.slice(i).join("/"), f);
      push(stemIndex, basename(f), f);
    }
  }
  const resolveTarget = (targetRaw: string, sourcePath?: string): ResolveResult => {
    const target = targetRaw.replace(/\.md$/, "");
    if (target.startsWith("/")) return exactPathIndex.get(target.slice(1)) ?? null;
    if (target.startsWith("./") || target.startsWith("../")) {
      if (!sourcePath) return null;
      const rel = posix.normalize(posix.join(posix.dirname(sourcePath), target));
      if (rel === ".." || rel.startsWith("../")) return null;
      return exactPathIndex.get(rel) ?? null;
    }
    const exact = exactPathIndex.get(target);
    if (exact) return exact;
    let matches = suffixIndex.get(target);
    if (matches?.length === 1) return matches[0];
    if (matches && matches.length > 1) return "ambiguous";
    matches = stemIndex.get(target.split("/").pop() ?? target);
    if (matches?.length === 1) return matches[0];
    if (matches && matches.length > 1) return "ambiguous";
    return null;
  };
  const getCollisions = (): Collision[] => [...stemIndex.keys()].sort().flatMap((stem) => {
    const entries = stemIndex.get(stem) ?? [];
    return entries.length > 1 ? [{ stem, files: [...entries].sort() }] : [];
  });
  return { resolve: resolveTarget, getCollisions };
}
export function parseTaxonomy(): Set<string> { return new Set(taxonomyMap(ROOT).keys()); }
export function checkFrontmatter(rel: string, text: string, validTags: Set<string>): string[] {
  if (FM_EXEMPT.has(rel) || isDatedLog(rel) || isAgentContract(rel) || isPackaging(rel)) return [];
  const issues: string[] = [];
  const parsed = parseFrontmatter(text);
  if (parsed.status !== "ok") {
    if (parsed.status === "malformed" || basename(rel) !== "README.md") issues.push(`${rel}: ${parsed.status === "malformed" ? "malformed" : "missing"} frontmatter`);
    return issues;
  }
  const fm = frontmatter(text);
  if (!fm.type) issues.push(`${rel}: missing type in frontmatter`);
  else if (!VALID_TYPES.has(fm.type)) issues.push(`${rel}: unknown type '${fm.type}'`);
  if (!fm.title) issues.push(`${rel}: missing title in frontmatter`);
  if (rel.startsWith("drafts/") && !rel.endsWith("/README.md")) {
    if (rel.startsWith("drafts/articles/") && fm.type !== "article-draft") issues.push(`${rel}: drafts/articles pages require type 'article-draft'`);
    else if (rel.startsWith("drafts/posts/") && fm.type !== "post-draft") issues.push(`${rel}: drafts/posts pages require type 'post-draft'`);
    else if (!rel.startsWith("drafts/articles/") && !rel.startsWith("drafts/posts/")) issues.push(`${rel}: content pages cannot live directly under drafts/`);
  }
  const tags = frontmatterFieldValues(text, "tags");
  if (tags.length === 0) issues.push(`${rel}: missing non-empty tags in frontmatter`);
  for (const tag of tags) if (!validTags.has(tag)) issues.push(`${rel}: tag '${tag}' not in SCHEMA taxonomy`);
  return issues;
}
export function checkWikilinks(rel: string, text: string, resolveTarget: (target: string, sourcePath?: string) => ResolveResult): string[] {
  if (isPackaging(rel)) return [];
  const issues: string[] = [];
  for (let target of matchAllGroup1(text, /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g)) {
    target = target.trim();
    if (!target || startsWithAny(target, ["?", "http://", "https://"])) continue;
    if (TEMPLATE_TARGETS.has(target) && TEMPLATE_SOURCES.has(rel)) continue;
    if (target.startsWith("raw/assets/")) {
      const found = ["", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".mp4", ".pdf"].some((ext) => existsSync(join(ROOT, target + ext)));
      if (!found) issues.push(`${rel}: missing asset [[${target}]]`);
      continue;
    }
    const result = resolveTarget(target, rel);
    if (result === null) issues.push(`${rel}: dead link [[${target}]]`);
    else if (result === "ambiguous") issues.push(`${rel}: ambiguous link [[${target}]] — use longer path`);
  }
  return issues;
}
export function checkIndexCoverage(rel: string, indexText: string, resolveTarget: (target: string, sourcePath?: string) => ResolveResult): string | null {
  if (isIndexExempt(rel)) return null;
  for (const raw of matchAllGroup1(indexText, /\[\[([^\]|#]+)/g)) {
    const target = raw.trim();
    if (target && !target.startsWith("?") && resolveTarget(target, "index.md") === rel) return null;
  }
  return `${rel}: not in index.md`;
}
export function checkSourcePreservation(rel: string, text: string): string | null {
  if (!startsWithAny(rel, ["ideas/", "notes/", "drafts/"]) || rel.endsWith("/README.md")) return null;
  if (/Исходник|Исходный набросок|Original input|Original draft|source_preservation:/i.test(text)) return null;
  return `${rel}: missing source preservation marker`;
}
export function checkOutboundLinks(rel: string, text: string): string | null {
  if (FM_EXEMPT.has(rel) || META_PATHS.has(rel) || isDatedLog(rel) || isAgentContract(rel) || isPackaging(rel)) return null;
  if (startsWithAny(rel, ["raw/", "_archive/", ".hermes/", "readouts/", "drafts/", "pages/", "adr/"])) return null;
  const targets = matchAllGroup1(text, /\[\[([^\]]+)\]\]/g).map((t) => t.split("|")[0].split("#")[0].trim());
  const valid = new Set(targets.filter((t) => t && !t.startsWith("raw/assets/"))).size;
  return valid < 2 ? `${rel}: only ${valid} outbound wikilink(s) — minimum 2 recommended` : null;
}
const TYPE_TAG_MAP: Record<string, Set<string>> = {
  note: new Set(["thought", "learning"]), idea: new Set(["idea"]),
  "post-draft": new Set(["content"]), "article-draft": new Set(["content"]),
  readout: new Set(["readout"]), comparison: new Set(["comparison"]), query: new Set(["summary"]), adr: new Set(["adr"]),
};
export function checkTypeToTag(rel: string, text: string): string | null {
  if (FM_EXEMPT.has(rel) || META_PATHS.has(rel) || isPackaging(rel) || startsWithAny(rel, ["raw/", "_archive/", ".hermes/", "pages/"])) return null;
  const tp = frontmatter(text).type ?? ""; const required = TYPE_TAG_MAP[tp];
  if (!required) return null;
  const tags = frontmatterFieldValues(text, "tags");
  return tags.some((t) => required.has(t)) ? null : `${rel}: type=${tp} requires tag ${[...required].sort().join(" or ")} — missing`;
}
export function checkSourcesIntegrity(rel: string, text: string): string | null {
  if (FM_EXEMPT.has(rel) || isPackaging(rel) || startsWithAny(rel, ["_archive/", ".hermes/"])) return null;
  const fm = frontmatter(text);
  if (fm.source_preservation !== "full" || fm.type === "raw-source") return null;
  if (frontmatterFieldValues(text, "sources").length || frontmatterFieldValues(text, "raw_sources").length) return null;
  if (/^## (?:Исходник|Исходный набросок|Original input|Original draft)\s*$/im.test(text)) return null;
  return `${rel}: source_preservation=full but sources: is empty/missing`;
}
export function checkBadSources(rel: string, text: string): string | null {
  if (FM_EXEMPT.has(rel) || isPackaging(rel) || startsWithAny(rel, ["_archive/", ".hermes/", "raw/"])) return null;
  for (const item of frontmatterFieldValues(text, "sources")) {
    if (!allowedSourceValue(item)) return `${rel}: bad sources: — only raw/ or external URLs allowed in sources: (${item})`;
  }
  for (const item of frontmatterFieldValues(text, "raw_sources")) {
    if (isAbsoluteFilesystemPath(item)) return `${rel}: bad raw_sources: — absolute filesystem paths are not portable; use raw/ or repo-relative provenance (${item})`;
  }
  return null;
}
export function checkAbsoluteMarkdownLinks(rel: string, text: string): string[] {
  if (FM_EXEMPT.has(rel) || isPackaging(rel) || startsWithAny(rel, ["_archive/", ".hermes/", "raw/"])) return [];
  const issues: string[] = [];
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g)) {
    const destination = (match[1] ?? match[2] ?? "").trim();
    if (isAbsoluteFilesystemPath(destination)) issues.push(`${rel}: absolute filesystem path in Markdown link (${destination})`);
  }
  return issues;
}
export function findOrphans(files: string[], resolveTarget: (target: string, sourcePath?: string) => ResolveResult, allLinks: Map<string, Set<string>>): string[] {
  const incoming = new Map<string, Set<string>>();
  for (const [sourceRel, targets] of allLinks) {
    if (["index.md", "log.md", "SCHEMA.md", "AGENTS.md"].includes(sourceRel) || isDatedLog(sourceRel)) continue;
    if (isPackaging(sourceRel) || startsWithAny(sourceRel, ["raw/", ".hermes/", "_archive/"])) continue;
    for (const target of targets) {
      const result = resolveTarget(target, sourceRel);
      if (result && result !== "ambiguous" && result !== sourceRel) {
        const set = incoming.get(result) ?? new Set<string>(); set.add(sourceRel); incoming.set(result, set);
      }
    }
  }
  return files.filter((rel) => !isOrphanExempt(rel) && !incoming.get(rel)?.size);
}
export type Report = {
  checked: number; errors: number; warnings: number; info: number;
  collisions: Collision[]; orphans: string[]; items: { errors: string[]; warnings: string[]; info: string[] };
};
export function runChecks(): { report: Report; hasErrors: boolean } {
  const files = mdFiles();
  const { resolve: resolveTarget, getCollisions } = buildResolver(allWikiFiles());
  const validTags = parseTaxonomy();
  const indexText = existsSync(join(ROOT, "index.md")) ? readText("index.md") : "";
  const errors: string[] = []; const warnings: string[] = []; const info: string[] = [];
  const allLinks = new Map<string, Set<string>>();
  for (const f of files) {
    const text = readText(f);
    const targets = new Set(matchAllGroup1(text, /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g)
      .map((t) => t.trim().replace(/\.md$/, "")).filter((t) => t && !startsWithAny(t, ["?", "http:", "https:", "raw/assets/"])));
    allLinks.set(f, targets);
  }
  for (const rel of files) {
    if (rel.startsWith("_archive/")) continue;
    const text = readText(rel);
    errors.push(...checkFrontmatter(rel, text, validTags));
    warnings.push(...checkWikilinks(rel, text, resolveTarget));
    for (const issue of [checkIndexCoverage(rel, indexText, resolveTarget), checkSourcePreservation(rel, text), checkOutboundLinks(rel, text)]) if (issue) warnings.push(issue);
    for (const issue of [checkTypeToTag(rel, text), checkSourcesIntegrity(rel, text), checkBadSources(rel, text)]) if (issue) errors.push(issue);
    errors.push(...checkAbsoluteMarkdownLinks(rel, text));
  }
  const collisions = getCollisions();
  for (const c of collisions) if (c.stem !== "README") warnings.push(`collision: bare stem "${c.stem}" matches ${c.files.length} files: ${c.files.join(", ")}`);
  const orphans = findOrphans(files, resolveTarget, allLinks);
  for (const rel of orphans) warnings.push(`orphan: ${rel} (0 incoming links)`);
  const report: Report = { checked: files.length, errors: errors.length, warnings: warnings.length, info: info.length, collisions, orphans, items: { errors, warnings, info } };
  return { report, hasErrors: errors.length > 0 };
}
export function main(argv: string[]): number {
  const { report, hasErrors } = runChecks();
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else if (!argv.includes("--quiet")) {
    console.log(`# Wiki Health\nChecked: ${report.checked}; errors: ${report.errors}; warnings: ${report.warnings}; info: ${report.info}`);
    for (const bucket of ["errors", "warnings", "info"] as const) {
      if (!report.items[bucket].length) continue;
      console.log(`\n## ${bucket}\n${report.items[bucket].join("\n")}`);
    }
  }
  return hasErrors || (argv.includes("--strict") && report.warnings > 0) ? 1 : 0;
}
if (import.meta.main) process.exit(main(process.argv.slice(2)));
