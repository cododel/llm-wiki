// Ported from the retired legacy suite; behavior parity was verified during cutover.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyIssue,
  frontmatterFieldValues,
  allowedSourceValue,
  WIKI_MD_PATH_RE,
  tagGovernanceReport,
  markdown,
  type LintReport,
} from "./wiki_lint.ts";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("factcheck not-indexed is generated-artifact noise", () => {
  expect(classifyIssue("readouts/2026-07-05-factcheck-abc123-summary.md: not in index.md")).toBe(
    "generated_factcheck_artifact",
  );
});

test("content page not-indexed is a content-graph issue", () => {
  expect(classifyIssue("ideas/some-new-idea.md: not in index.md")).toBe("content_graph");
});

test("asset orphan is an evidence-integrity issue", () => {
  expect(classifyIssue("raw/assets/topic/screenshot.jpg: asset orphan")).toBe("evidence_integrity");
});

test("multiline sources with a wiki page is invalid", () => {
  const text = "---\ntitle: Bad sources\nsources:\n  - raw/user-notes/foo.md\n  - concepts/bar.md\n---\n";
  const values = frontmatterFieldValues(text, "sources");
  expect(values).toContain("concepts/bar.md");
  expect(values.every((v) => allowedSourceValue(v))).toBe(false);
});

test("multiline sources with raw/external only is valid", () => {
  const text = "---\ntitle: Good sources\nsources:\n  - raw/user-notes/foo.md\n  - https://example.com/source\n---\n";
  const values = frontmatterFieldValues(text, "sources");
  expect(values.every((v) => allowedSourceValue(v))).toBe(true);
});

test("backticked wiki .md path is detectable", () => {
  // WIKI_MD_PATH_RE is global (used with matchAll); use a fresh non-global copy to mirror Python .search().
  expect(new RegExp(WIKI_MD_PATH_RE.source).test("`concepts/foo.md`")).toBe(true);
});

function makeGovernanceWiki(): string {
  const root = mkdtempSync(join(tmpdir(), "wiki-lint-test-"));
  cleanup.push(root);
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  write("SCHEMA.md", "# Wiki Schema\n\n## Tag Taxonomy\n\n### Wiki Operations & Provenance\n- source, wiki\n\n### Product & Business\n- idea\n\nRule: every tag on a page must appear in this taxonomy.\n\n### Tag Governance\n- policy prose, not tags\n");
  write("ideas/project/README.md", "---\ntitle: Project\ntype: idea\ntags: [idea]\n---\n# Project\n");
  write("ideas/empty-tags.md", "---\ntitle: Empty tags\ntype: idea\ntags: []\n---\n# Empty tags\n");
  write("raw/user-notes/legacy.md", "---\ntitle: Legacy raw\nsha256: not-a-digest\ntags: [wiki]\nprocessed_to:\n  - ideas/project\n---\nraw body\n");
  return root;
}

test("tag governance report reuses wiki_tags buckets", () => {
  const report = tagGovernanceReport(makeGovernanceWiki());
  expect(report.missing_tags).toContain("ideas/empty-tags.md");
  expect(report.raw_missing_type).toContain("raw/user-notes/legacy.md");
  expect(report.raw_missing_source_kind).toContain("raw/user-notes/legacy.md");
  expect(report.raw_missing_source_channel).toContain("raw/user-notes/legacy.md");
  expect(report.raw_missing_ingested).toContain("raw/user-notes/legacy.md");
  expect(report.raw_bad_sha256_format).toContain("raw/user-notes/legacy.md: not-a-digest");
  expect(report.raw_bad_processed_to_format).toContain("raw/user-notes/legacy.md: ideas/project");
});

test("markdown surfaces new governance buckets", () => {
  const report: LintReport = {
    health_errors: [],
    health_warnings: [],
    missing_tags: ["ideas/empty-tags.md"],
    singleton_tags: [{ tag: "wiki", count: 1, category: "Wiki Operations & Provenance" }],
    missing_sha256: [],
    sha256_mismatches: [],
    unknown_tags: [],
    raw_missing_type: ["raw/user-notes/legacy.md"],
    raw_missing_source_kind: [],
    raw_bad_source_kind: [],
    raw_missing_source_channel: [],
    raw_bad_source_channel: [],
    raw_missing_source_tag: [],
    raw_metadata_tags_duplicated: [],
    raw_missing_ingested: [],
    raw_missing_sha256: [],
    raw_bad_sha256: ["raw/user-notes/legacy.md: bad digest"],
    raw_missing_processed_to: [],
    raw_processed_to_invalid: [],
    raw_web_missing_source_url: [],
    oversized_pages: [],
    asset_orphans: [],
    untracked_factcheck_readouts: [],
    bad_sources: [],
    bad_wikilinks: [],
    low_outbound_links: [],
    categories: {},
    malformed_frontmatter: [],
  };
  const output = markdown(report);
  expect(output).toContain("| Missing tags | 1 |");
  expect(output).toContain("## Raw bad SHA256 (1)");
});
