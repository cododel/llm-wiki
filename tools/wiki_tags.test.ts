// Ported from the retired legacy suite; behavior parity was verified during cutover.
// The live --json harness proves the happy path on the real wiki; these
// fixture tests exercise the governance-gap paths the clean wiki never hits.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  parseFrontmatter,
  iterMarkdownFiles,
  fieldAsList,
  loadRecords,
  parseTaxonomy,
  tagCounts,
  sortedCounts,
  pagesForTag,
  suggestTags,
  validationReport,
  validationHasBlockingIssues,
  validProcessedToTarget,
  findRecord,
  renderShow,
  renderValidate,
  renderSuggest,
  main,
  type PageRecord,
} from "./wiki_tags.ts";

const SCHEMA = `# Wiki Schema

## Tag Taxonomy

### Wiki Operations & Provenance
- source, wiki, provenance

### Product & Business
- idea, product

### Content & Creation
- content

### Hermes & Tooling
- telegram, automation

### Ideas & Notes
- thought, learning

Rule: every tag on a page must appear in this taxonomy.

### Tag Governance

- this sentence is policy, not a tag
- source channels (\`telegram\`, \`web\`) belong in source_channel

### Type-to-Tag Convention

## Page Types
`;

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function makeWiki(): string {
  const root = mkdtempSync(join(tmpdir(), "wiki-tags-test-"));
  cleanup.push(root);
  write(root, "SCHEMA.md", SCHEMA);
  write(root, "ideas/one.md", "---\ntitle: One\ntype: idea\ntags: [idea, product]\n---\n# Product idea\n");
  write(root, "concepts/wiki.md", "---\ntitle: Wiki\ntype: concept\ntags:\n  - wiki\n  - automation\n---\n# Wiki automation\n");
  write(root, "concepts/telegram.md", "---\ntitle: Telegram automation\ntype: concept\ntags: [automation]\n---\n# Telegram automation\n\nTelegram bot workflows and channel routing.\n");
  write(root, "ideas/project/README.md", "---\ntitle: Project Overview\ntype: idea\ntags: [idea]\n---\n# Project\n");
  write(root, "raw/user-notes/raw.md", `---\ntitle: Raw note\ntype: raw-source\nsource_kind: user-note\nsource_channel: telegram\ningested: 2026-07-08\nsha256: ${"0".repeat(64)}\ntags: [source]\nprocessed_to: []\n---\nTelegram note about wiki automation.\n`);
  write(root, "ideas/missing-tags.md", "---\ntitle: Missing Tags\ntype: idea\n---\n# Missing tags\n");
  write(root, "ideas/unknown.md", "---\ntitle: Unknown\ntype: idea\ntags: [idea, brand-new]\n---\n# Unknown\n");
  return root;
}

function requireRecord(records: PageRecord[], rel: string, root: string): PageRecord {
  const record = findRecord(records, rel, root);
  if (record === null) throw new Error(`fixture record not found: ${rel}`);
  return record;
}

/** Run main() with stdout/stderr suppressed so CLI output does not pollute the test log. */
function runSilently(fn: () => number): number {
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return fn();
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
}

test("parse inline and multiline tags", () => {
  const inline = parseFrontmatter("---\ntags: [idea, product]\n---\nbody");
  const multiline = parseFrontmatter("---\ntags:\n  - wiki\n  - automation\n---\nbody");
  expect(fieldAsList(inline.data["tags"])).toEqual(["idea", "product"]);
  expect(fieldAsList(multiline.data["tags"])).toEqual(["wiki", "automation"]);
});

test("strict frontmatter rejects invalid scalars and swallowed markdown", () => {
  expect(parseFrontmatter("---\ntitle: Article draft: Cloudflare WARP fix\n---\nbody").status).toBe("malformed");
  expect(parseFrontmatter("---\ntitle: Factcheck\n# Heading\n\n**Date:** 2026-07-05\n---\nbody").status).toBe("malformed");
});

test("markdown discovery excludes dependencies, worktrees, and tooling", () => {
  const root = makeWiki();
  write(root, "node_modules/pkg/README.md", "# dependency\n");
  write(root, ".claude/worktrees/agent/README.md", "# worktree\n");
  write(root, "tools/README.md", "# tooling\n");
  const rels = iterMarkdownFiles(root);
  expect(rels).not.toContain("node_modules/pkg/README.md");
  expect(rels).not.toContain(".claude/worktrees/agent/README.md");
  expect(rels).not.toContain("tools/README.md");
});

test("counts are filterable and categorized; policy prose is not a tag", () => {
  const root = makeWiki();
  const records = loadRecords(root);
  const taxonomy = parseTaxonomy(root);
  expect(tagCounts(records).get("idea")).toBe(3);
  expect(tagCounts(records, "raw").get("source")).toBe(1);
  expect(tagCounts(records, null, "concept").get("wiki")).toBe(1);
  expect(taxonomy.get("source")).toBe("Wiki Operations & Provenance");
  expect(taxonomy.get("telegram")).toBe("Hermes & Tooling");
  expect(taxonomy.has("this sentence is policy, not a tag")).toBe(false);
});

test("count ordering is count desc then tag ascending", () => {
  const rows = sortedCounts(new Map([["wiki", 2], ["idea", 3], ["automation", 2]]));
  expect(rows).toEqual([["idea", 3], ["automation", 2], ["wiki", 2]]);
});

test("folder filter matches subtree and ignores siblings", () => {
  const root = makeWiki();
  const counts = tagCounts(loadRecords(root), "ideas/project/");
  expect(counts.get("idea")).toBe(1);
  expect(counts.has("product")).toBe(false);
  expect(counts.has("source")).toBe(false);
});

test("type filter limits counts to frontmatter type", () => {
  const root = makeWiki();
  const counts = tagCounts(loadRecords(root), null, "concept");
  expect(counts.get("automation")).toBe(2);
  expect(counts.get("wiki")).toBe(1);
  expect(counts.has("idea")).toBe(false);
});

test("validate flags missing and unknown tags", () => {
  const root = makeWiki();
  const report = validationReport(loadRecords(root), parseTaxonomy(root), root);
  expect(report.missing_tags).toContain("ideas/missing-tags.md");
  expect(report.unknown_tags).toContain("ideas/unknown.md: brand-new");
});

test("suggest does not turn a raw file's own source_channel into a tag", () => {
  const root = makeWiki();
  const records = loadRecords(root);
  const record = requireRecord(records, "raw/user-notes/raw.md", root);
  const tags = suggestTags(record, records, parseTaxonomy(root)).map((s) => s.tag);
  expect(tags).not.toContain("telegram");
  expect(tags).toContain("wiki");
});

test("suggest allows source_channel terms as tags on non-raw pages", () => {
  const root = makeWiki();
  const records = loadRecords(root);
  const record = requireRecord(records, "concepts/telegram.md", root);
  const tags = suggestTags(record, records, parseTaxonomy(root)).map((s) => s.tag);
  expect(tags).toContain("telegram");
});

test("processed_to requires exact README-backed targets", () => {
  const root = makeWiki();
  expect(validProcessedToTarget("ideas/project", root)).toBe(false);
  expect(validProcessedToTarget("ideas/project/README", root)).toBe(true);
  expect(validProcessedToTarget("ideas/project.md", root)).toBe(false);
  expect(validProcessedToTarget("raw/user-notes/raw", root)).toBe(false);
});

test("validate reports raw ingested and sha256 gaps", () => {
  const root = makeWiki();
  write(root, "raw/user-notes/raw-no-digest.md", "---\ntitle: Raw without digest\ntype: raw-source\nsource_kind: user-note\nsource_channel: manual\ntags: [source]\nprocessed_to: []\n---\nraw body\n");
  const report = validationReport(loadRecords(root), parseTaxonomy(root), root);
  expect(report.raw_missing_ingested).toContain("raw/user-notes/raw-no-digest.md");
  expect(report.raw_missing_sha256).toContain("raw/user-notes/raw-no-digest.md");
});

test("validate reports raw metadata duplicated as tags", () => {
  const root = makeWiki();
  write(root, "raw/user-notes/duplicate.md", `---\ntitle: Duplicate\ntype: raw-source\nsource_kind: user-note\nsource_channel: telegram\ningested: 2026-07-13\nsha256: ${"0".repeat(64)}\ntags: [source, telegram]\nprocessed_to: []\n---\nbody\n`);
  const report = validationReport(loadRecords(root), parseTaxonomy(root), root);
  expect(report.raw_metadata_tags_duplicated).toContain("raw/user-notes/duplicate.md: telegram");
});

test("validate reports type-required tag gaps", () => {
  const root = makeWiki();
  write(root, "ideas/product-without-idea-tag.md", "---\ntitle: Product without idea tag\ntype: idea\ntags: [product]\n---\n# Product without idea tag\n");
  const report = validationReport(loadRecords(root), parseTaxonomy(root), root);
  expect(report.missing_type_required_tags.join("\n")).toContain(
    "ideas/product-without-idea-tag.md: type=idea requires one of idea",
  );
});

test("blocking issues are detected for governance gaps", () => {
  const root = makeWiki();
  const report = validationReport(loadRecords(root), parseTaxonomy(root), root);
  // fixture has missing_tags + unknown_tags, both blocking keys
  expect(validationHasBlockingIssues(report)).toBe(true);
});

test("human validate lists absent-frontmatter files", () => {
  const root = makeWiki();
  const report = validationReport(loadRecords(root), parseTaxonomy(root), root);
  const output = renderValidate(report, false);
  expect(output).toContain("## absent_frontmatter");
  expect(output).toContain("SCHEMA.md");
});

test("show by tag outputs pages in stable path order", () => {
  const root = makeWiki();
  const pages = pagesForTag(loadRecords(root), "idea");
  expect(pages).toEqual(["ideas/one.md", "ideas/project/README.md", "ideas/unknown.md"]);
  expect(renderShow("idea", pages, false).trimEnd().split("\n")).toEqual([
    "# Pages tagged 'idea' (3)",
    "ideas/one.md",
    "ideas/project/README.md",
    "ideas/unknown.md",
  ]);
});

test("suggest json payload has context counts and policy hints", () => {
  const root = makeWiki();
  const records = loadRecords(root);
  const record = requireRecord(records, "concepts/telegram.md", root);
  const payload = JSON.parse(renderSuggest(record, records, parseTaxonomy(root), true));
  expect(payload.file).toBe("concepts/telegram.md");
  expect(payload.current.type).toBe("concept");
  for (const key of ["nearest_existing_tags", "global_top_tags", "same_folder_top_tags", "same_type_top_tags", "schema_hints"]) {
    expect(payload).toHaveProperty(key);
  }
  expect(payload.schema_hints).toHaveProperty("new_tag_policy");
  const suggestion = payload.nearest_existing_tags[0];
  for (const key of ["tag", "category", "score", "global_count", "reasons"]) {
    expect(suggestion).toHaveProperty(key);
  }
});

test("main dispatches subcommands and returns documented exit codes", () => {
  const root = makeWiki();
  // suggest with a missing file → 2 (writes to stderr, not stdout)
  expect(runSilently(() => main(["--root", root, "suggest", "--file", "does/not/exist.md", "--json"]))).toBe(2);
  // validate --strict with blocking gaps present in the fixture → 1
  expect(runSilently(() => main(["--root", root, "validate", "--strict", "--json"]))).toBe(1);
});

test("agent worktrees under .claude are excluded from scanning", () => {
  const root = makeWiki();
  mkdirSync(join(root, ".claude", "worktrees", "agent"), { recursive: true });
  writeFileSync(join(root, ".claude", "worktrees", "agent", "dup.md"), "---\ntitle: Dup\ntype: idea\ntags: [idea]\n---\n# dup\n");
  const records = loadRecords(root);
  // a duplicate wiki copy inside .claude/worktrees must not inflate counts or be recorded
  expect(tagCounts(records).get("idea")).toBe(3);
  expect(records.some((r) => r.rel.startsWith(".claude/"))).toBe(false);
});
