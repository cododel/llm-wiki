// Ported from the retired legacy suite; behavior parity was verified during cutover.
import { expect, test } from "bun:test";
import {
  isGeneratedFactcheckReadout,
  isIndexExempt,
  isOrphanExempt,
  checkFrontmatter,
  checkOutboundLinks,
  checkBadSources,
  checkAbsoluteMarkdownLinks,
  checkIndexCoverage,
  checkWikilinks,
  buildResolver,
} from "./wiki_health.ts";

test("health resolver requires an explicit README filename for directory entry pages", () => {
  const r = buildResolver([
    "README.md",
    "concepts/agentic-stack-choices/README.md",
  ]).resolve;
  expect(r("agentic-stack-choices")).toBeNull();
  expect(r("agentic-stack-choices/README")).toBe("concepts/agentic-stack-choices/README.md");
  expect(r("README")).toBe("README.md");
});

test("index coverage requires README to appear in the indexed target", () => {
  const r = buildResolver([
    "README.md",
    "ideas/project/README.md",
  ]).resolve;
  expect(checkIndexCoverage(
    "ideas/project/README.md",
    "- [[README]] — root README only",
    r,
  )).toBe("ideas/project/README.md: not in index.md");
  expect(checkIndexCoverage(
    "ideas/project/README.md",
    "- [[project]] — invalid folder shorthand",
    r,
  )).toBe("ideas/project/README.md: not in index.md");
  expect(checkIndexCoverage(
    "ideas/project/README.md",
    "- [[project/README]] — valid entry page",
    r,
  )).toBeNull();
});

test("health checker validates explicit relative wikilinks from the source directory", () => {
  const r = buildResolver([
    "ideas/project/README.md",
    "ideas/project/product-vision.md",
  ]).resolve;
  expect(checkWikilinks(
    "ideas/project/product-vision.md",
    "[[./README]] and [[../README]]",
    r,
  )).toEqual([
    "ideas/project/product-vision.md: dead link [[../README]]",
  ]);
});

test("health resolver preserves extensions for relative attachment links", () => {
  const r = buildResolver([
    "ideas/project/product-vision.md",
    "ideas/project/diagram.png",
  ]).resolve;
  expect(r("./diagram.png", "ideas/project/product-vision.md")).toBe("ideas/project/diagram.png");
  expect(r("/ideas/project/diagram.png")).toBe("ideas/project/diagram.png");
});

test("factcheck batch readout is a generated artifact", () => {
  expect(isGeneratedFactcheckReadout("readouts/2026-07-05-factcheck-1c3ed2828f24-batch-01.md")).toBe(true);
});

test("factcheck summary readout is a generated artifact", () => {
  expect(isGeneratedFactcheckReadout("readouts/2026-07-05-factcheck-1c3ed2828f24-summary.md")).toBe(true);
});

test("regular readout is not a generated factcheck artifact", () => {
  expect(isGeneratedFactcheckReadout("readouts/2026-07-01-telegram-topic-env-mismatch.md")).toBe(false);
});

test("generated factcheck readout is index-exempt", () => {
  expect(isIndexExempt("readouts/2026-07-05-factcheck-1c3ed2828f24-summary.md")).toBe(true);
});

test("generated factcheck readout is orphan-exempt", () => {
  expect(isOrphanExempt("readouts/2026-07-05-factcheck-1c3ed2828f24-batch-01.md")).toBe(true);
});

test("bad_sources catches a multiline wiki-page source", () => {
  const text = "---\ntitle: Bad sources\nsources:\n  - raw/user-notes/foo.md\n  - concepts/bar.md\n---\n";
  const issue = checkBadSources("ideas/example.md", text);
  expect(issue).not.toBeNull();
  expect(issue).toContain("concepts/bar.md");
});

test("bad_sources allows multiline raw and external", () => {
  const text = "---\ntitle: Good sources\nsources:\n  - raw/user-notes/foo.md\n  - https://example.com/source\n---\n";
  expect(checkBadSources("ideas/example.md", text)).toBeNull();
});

test("bad_sources rejects absolute filesystem paths in raw_sources", () => {
  const bad = "---\ntitle: Bad raw sources\nraw_sources: [raw/user-notes/foo.md, /root/projects/portfolio-tracker/README.md]\n---\n";
  const issue = checkBadSources("ideas/example.md", bad);
  expect(issue).not.toBeNull();
  expect(issue).toContain("raw_sources");
  expect(issue).toContain("/root/projects/portfolio-tracker/README.md");

  const good = "---\ntitle: Good raw sources\nraw_sources: [raw/user-notes/foo.md, git — old vault import]\n---\n";
  expect(checkBadSources("ideas/example.md", good)).toBeNull();
});

test("health rejects absolute filesystem paths used as Markdown link destinations", () => {
  const text = [
    "[README](/root/projects/portfolio-tracker/README.md)",
    "[external](https://example.com/README.md)",
    "[portable](./README.md)",
  ].join("\n");
  expect(checkAbsoluteMarkdownLinks("ideas/example.md", text)).toEqual([
    "ideas/example.md: absolute filesystem path in Markdown link (/root/projects/portfolio-tracker/README.md)",
  ]);
});

// CLAUDE.md is agent config (like AGENTS.md), not a content page.
test("CLAUDE.md is frontmatter-exempt", () => {
  expect(checkFrontmatter("tools/mcp-wiki-server/CLAUDE.md", "# CLAUDE.md\n\nno frontmatter\n", new Set())).toEqual([]);
});

test("CLAUDE.md is outbound-links-exempt", () => {
  expect(checkOutboundLinks("tools/mcp-wiki-server/CLAUDE.md", "# CLAUDE.md\n\nonly [[one-link]]\n")).toBeNull();
});

test("CLAUDE.md is orphan-exempt", () => {
  expect(isOrphanExempt("tools/mcp-wiki-server/CLAUDE.md")).toBe(true);
});

test("readout template placeholders are suppressed", () => {
  expect(checkWikilinks(
    "readouts/README.md",
    "[[concept-slug]] and [[ideas/project-slug]]",
    () => null,
  )).toEqual([]);
});

test("schema relative-link examples are suppressed", () => {
  expect(checkWikilinks(
    "SCHEMA.md",
    "Use [[./sub-page]] as an example.",
    () => null,
  )).toEqual([]);
});

test("draft content must use a typed draft sublayer", () => {
  const tags = new Set(["content"]);
  const page = (type: string) => `---\ntitle: Draft\ntype: ${type}\ntags: [content]\n---\nbody\n`;
  expect(checkFrontmatter("drafts/orphan.md", page("post-draft"), tags)).toContain(
    "drafts/orphan.md: content pages cannot live directly under drafts/",
  );
  expect(checkFrontmatter("drafts/articles/article.md", page("post-draft"), tags)).toContain(
    "drafts/articles/article.md: drafts/articles pages require type 'article-draft'",
  );
  expect(checkFrontmatter("drafts/posts/post.md", page("post-draft"), tags)).toEqual([]);
  expect(checkFrontmatter("ideas/summary.md", page("summary"), tags)).toContain(
    "ideas/summary.md: unknown type 'summary'",
  );
});
