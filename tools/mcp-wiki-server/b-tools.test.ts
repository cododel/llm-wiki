// Extended readonly tools: bounded reads, provenance, catalog, resolution, and diagnostics.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { wikiResolve, wikiSearchAndRead, wikiGetPage, wikiGetSources, wikiGetRelated, wikiList,
  wikiHealthSummary, wikiLintSummary, wikiAuditVisibility, type ToolCtx } from "./tools.ts";
const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function write(root: string, rel: string, text: string): void {
  const path = join(root, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
}
function plantB(): ToolCtx {
  const dir = mkdtempSync(join(tmpdir(), "mcp-b-test-")); cleanup.push(dir);
  const page = (rel: string, title: string, body: string, extra = "", visible = true): void => {
    write(dir, rel, `---\ntitle: ${title}\ntype: concept\ntags: [pattern]\n${visible ? "visibility: public\n" : ""}${extra}---\n${body}\n`);
  };
  page("concepts/alpha.md", "Alpha", "Intro paragraph about banana.\n\n## Overview\n\nOverview body about the alpha pattern.\n\n## Details\n\nDeep details here. links [[beta]] and [[secret-idea]].", "confidence: high\ncreated: 2026-01-01\n");
  page("concepts/beta.md", "Beta", "links back to [[alpha]].", "created: 2026-01-02\n");
  page("concepts/dup.md", "Dup Concept", "concept dup body.");
  page("pages/dup.md", "Dup Page", "page dup body.");
  page("ideas/secret-idea.md", "Secret", "banana secret sauce. links [[alpha]].", "", false);
  page("concepts/big.md", "Big", "banana ".repeat(400));
  page("concepts/processed.md", "Processed", "processed content about banana.", "sources:\n  - raw/user-notes/src.md\n  - https://example.com/article\nraw_sources: [raw/user-notes/src.md]\n");
  write(dir, "raw/user-notes/src.md", "---\ntitle: Src\ntype: raw-source\nsource_kind: user-note\nsource_channel: manual\nprocessed_to:\n  - concepts/processed\n---\nraw source body.\n");
  write(dir, "SCHEMA.md", "## Tag Taxonomy\n### Methods\n- pattern, source\n\n## Policy\n");
  write(dir, "index.md", "# Index\n");
  return { wikiDir: dir, dbPath: join(dir, ".wiki-fts5.db"), scope: "public" };
}
test("search-and-read gates private hits and bounds every excerpt", () => {
  const res = wikiSearchAndRead(plantB(), { query: "banana", limit: 10, maxCharsPerPage: 40 });
  expect(res.results.map((r) => r.path)).not.toContain("ideas/secret-idea.md");
  for (const r of res.results) expect(r.excerpt.length).toBeLessThanOrEqual(40);
  expect(res.results.find((r) => r.path === "concepts/big.md")?.truncated).toBe(true);
});
test("page section excludes sibling headings and preamble", () => {
  const res = wikiGetPage(plantB(), { path: "concepts/alpha.md", section: "Overview" });
  expect(res.ok).toBe(true); if (!res.ok) return;
  expect(res.markdown).toContain("Overview body"); expect(res.markdown).not.toContain("Deep details"); expect(res.markdown).not.toContain("Intro paragraph");
});
test("page output honors maxChars", () => {
  const res = wikiGetPage(plantB(), { path: "concepts/alpha.md", maxChars: 20 });
  expect(res.ok).toBe(true); if (res.ok) { expect(res.markdown.length).toBeLessThanOrEqual(20); expect(res.truncated).toBe(true); }
});
test("unknown section is an error", () => { expect(wikiGetPage(plantB(), { path: "concepts/alpha.md", section: "Nonexistent" }).ok).toBe(false); });
test("processed provenance includes raw_sources without granting target access", () => {
  const ctx = plantB(); const res = wikiGetSources(ctx, { path: "concepts/processed.md" });
  expect(res.ok).toBe(true); if (!res.ok) return;
  expect(res.sources).toContain("raw/user-notes/src.md"); expect(res.sources).toContain("https://example.com/article");
  expect(res.raw_sources).toEqual(["raw/user-notes/src.md"]);
  expect(wikiGetSources(ctx, { path: "raw/user-notes/src.md" }).ok).toBe(false);
});
test("admin can read raw provenance and processed_to", () => {
  const res = wikiGetSources({ ...plantB(), scope: "admin" }, { path: "raw/user-notes/src.md" });
  expect(res.ok).toBe(true); if (res.ok) { expect(res.source_channel).toBe("manual"); expect(res.processed_to).toContain("concepts/processed"); }
});
test("related entries include relation, original anchor, and context", () => {
  const res = wikiGetRelated(plantB(), { path: "concepts/alpha.md" }); expect(res.ok).toBe(true); if (!res.ok) return;
  const beta = res.outbound.find((o) => o.path === "concepts/beta.md");
  expect(beta?.relation).toBe("outbound"); expect(beta?.anchor).toBe("beta"); expect(beta?.snippet).toContain("Deep details");
  expect(res.inbound.find((o) => o.path === "concepts/beta.md")?.relation).toBe("inbound");
  expect(res.outbound.map((o) => o.path)).not.toContain("ideas/secret-idea.md");
});
test("catalog title ordering and pagination preserve total count", () => {
  const ctx = plantB(); const all = wikiList(ctx, { sort: "title", order: "asc" }); const titles = all.pages.map((p) => p.title);
  expect(titles).toEqual([...titles].sort());
  const page = wikiList(ctx, { sort: "title", order: "asc", offset: 1, limit: 2 });
  expect(page.pages.length).toBe(2); expect(page.pages[0].title).toBe(titles[1]); expect(page.count).toBe(all.count);
});
test("catalog confidence and explicit visibility filters", () => {
  const ctx = plantB(); const res = wikiList(ctx, { confidence: "high" });
  expect(res.pages.map((p) => p.path)).toContain("concepts/alpha.md"); expect(res.pages.every((p) => p.confidence === "high")).toBe(true);
  expect(wikiList(ctx, { visibility: "private" }).pages).toEqual([]);
});
test("visibility audit always uses public scope, including for admin", () => {
  const ctx = plantB(); const result = wikiAuditVisibility({ ...ctx, scope: "admin" }); const paths = result.exposed.map((e) => e.path);
  expect(paths).toContain("concepts/alpha.md"); expect(paths).not.toContain("ideas/secret-idea.md"); expect(paths).not.toContain("raw/user-notes/src.md");
});
test("diagnostics use the selected external vault without requiring scripts inside it", () => {
  const ctx = plantB(); const health = wikiHealthSummary({ ...ctx, scope: "admin" });
  expect(health.ok).toBe(true); if (health.ok) { expect(health.checked).toBe(10); expect(health.errors).toBeGreaterThan(0); }
  const lint = wikiLintSummary({ ...ctx, scope: "admin" }); expect(lint.ok).toBe(true);
  if (lint.ok) { expect(lint.summary).toHaveProperty("health_errors"); expect(lint.summary.raw_missing_ingested).toBe(1); }
});
test("resolver accepts bare stem and bracketed anchor/alias", () => {
  const ctx = plantB();
  for (const target of ["beta", "[[beta#Details|the beta]]"]) {
    const result = wikiResolve(ctx, { target }); expect(result.ok && "path" in result && result.path).toBe("concepts/beta.md");
  }
});
test("resolver denies a private target without revealing existence", () => { expect(wikiResolve(plantB(), { target: "secret-idea" })).toEqual({ ok: false, reason: "not found" }); });
test("resolver lists only visible candidates on ambiguity", () => {
  const res = wikiResolve(plantB(), { target: "dup" }); expect(res.ok).toBe(true);
  if (res.ok && "candidates" in res) expect(res.candidates.map((c) => c.path).sort()).toEqual(["concepts/dup.md", "pages/dup.md"]);
  else throw new Error("expected visible ambiguity candidates");
});
test("hidden duplicate cannot introduce public ambiguity", () => {
  const ctx = plantB(); write(ctx.wikiDir, "ideas/beta.md", "---\ntitle: Hidden beta\n---\nhidden duplicate\n");
  const res = wikiResolve(ctx, { target: "beta" }); expect(res.ok && "path" in res && res.path).toBe("concepts/beta.md");
});
