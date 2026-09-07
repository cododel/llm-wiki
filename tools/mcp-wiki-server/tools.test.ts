import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { wikiSearch, wikiRegexSearch, wikiGetPage, wikiGetRelated, wikiList, type ToolCtx } from "./tools.ts";
const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }); });
function plantWiki(): ToolCtx {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tools-test-")); cleanup.push(dir);
  const write = (rel: string, title: string, body: string, published = true, extra = "") => {
    const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `---\ntitle: ${title}\n${published ? "visibility: public\n" : ""}${extra}---\n${body}\n`);
  };
  write("concepts/alpha.md", "Alpha", "banana pattern. see [[beta]] and [[secret-idea]].");
  write("concepts/beta.md", "Beta", "links back to [[alpha]].");
  write("concepts/gamma.md", "Gamma", "banana too but public.");
  write("concepts/alpha-notes.md", "Alpha Notes", "unrelated.");
  write("concepts/eps.md", "Eps", "mentions [[alpha-notes]] only.");
  write("concepts/relative/source.md", "Relative Source", "links [[./target]].");
  write("concepts/relative/target.md", "Relative Target", "links [[./source]] and [[./nested/child]].");
  write("concepts/relative/nested/child.md", "Relative Child", "links [[../target]].");
  write("entities/thing.md", "Thing", "content.");
  write("drafts/pub.md", "Pub", "banana published draft.", true, "status: published\n");
  write("ideas/secret-idea.md", "Secret", "banana secret sauce. links [[alpha]].", false);
  write("readouts/ro.md", "RO", "banana readout.", false);
  return { wikiDir: dir, dbPath: join(dir, ".wiki-fts5.db"), scope: "public" };
}
test("search drops private matches before exposing snippets", () => {
  const res = wikiSearch(plantWiki(), { query: "banana", limit: 20 }); const paths = res.results.map((r) => r.path);
  for (const p of ["concepts/alpha.md", "concepts/gamma.md", "drafts/pub.md"]) expect(paths).toContain(p);
  for (const p of ["ideas/secret-idea.md", "readouts/ro.md"]) expect(paths).not.toContain(p);
  expect(JSON.stringify(res.results)).not.toContain("secret sauce");
});
test("search trims requested limit after authorization", () => {
  const res = wikiSearch(plantWiki(), { query: "banana", limit: 2 }); expect(res.results.length).toBe(2);
  for (const r of res.results) expect(["concepts/alpha.md", "concepts/gamma.md", "drafts/pub.md"]).toContain(r.path);
});
test("regex returns line evidence without private matches", () => {
  const res = wikiRegexSearch(plantWiki(), { pattern: "banana\\s+\\w+", limit: 20 }); expect(res.ok).toBe(true);
  if (!res.ok) return;
  const paths = res.results.map((r) => r.path);
  expect(paths).toContain("concepts/alpha.md"); expect(paths).toContain("concepts/gamma.md");
  expect(paths).not.toContain("ideas/secret-idea.md"); expect(JSON.stringify(res.results)).not.toContain("secret sauce");
  expect(res.results[0]).toHaveProperty("line"); expect(res.results[0]).toHaveProperty("match");
});
test("regex rejects unsupported look-around", () => {
  const res = wikiRegexSearch(plantWiki(), { pattern: "(?=banana)" }); expect(res.ok).toBe(false);
  if (!res.ok) expect(res.reason).toContain("invalid or unsupported regex");
});
test("regex applies case, filters, and a global match limit", () => {
  const ctx = plantWiki();
  const res = wikiRegexSearch(ctx, { pattern: "BANANA", caseSensitive: false, folder: "concepts", limit: 1 });
  expect(res.ok).toBe(true); if (!res.ok) return;
  expect(res.count).toBe(1); expect(res.truncated).toBe(true);
  expect(wikiRegexSearch(ctx, { pattern: "BANANA", caseSensitive: true }).ok).toBe(true);
});
test("regex cannot leak a multiline private-key payload from a public page", () => {
  const ctx = plantWiki();
  writeFileSync(join(ctx.wikiDir, "concepts/key.md"), "---\ntitle: Key\nvisibility: public\n---\n-----BEGIN PRIVATE KEY-----\nMULTILINESECRET\n-----END PRIVATE KEY-----\n");
  const res = wikiRegexSearch(ctx, { pattern: "MULTILINESECRET" }); expect(res.ok).toBe(true);
  if (res.ok) expect(res.count).toBe(0);
});
test("get page serves public and denies private; admin still reads private", () => {
  const ctx = plantWiki(); const ok = wikiGetPage(ctx, { path: "concepts/alpha.md" }); expect(ok.ok).toBe(true);
  if (ok.ok) expect(ok.markdown).toContain("banana pattern");
  expect(wikiGetPage(ctx, { path: "ideas/secret-idea.md" }).ok).toBe(false);
  expect(wikiGetPage({ ...ctx, scope: "admin" }, { path: "ideas/secret-idea.md" }).ok).toBe(true);
});
test("related filters private inbound/outbound and confirms exact backlinks", () => {
  const res = wikiGetRelated(plantWiki(), { path: "concepts/alpha.md" }); expect(res.ok).toBe(true); if (!res.ok) return;
  expect(res.outbound.map((o) => o.path)).toContain("concepts/beta.md");
  expect(res.outbound.map((o) => o.path)).not.toContain("ideas/secret-idea.md");
  expect(res.inbound.map((o) => o.path)).toContain("concepts/beta.md");
  expect(res.inbound.map((o) => o.path)).not.toContain("ideas/secret-idea.md");
  expect(res.inbound.map((o) => o.path)).not.toContain("concepts/eps.md");
});
test("related preserves explicit relative link anchors in both directions", () => {
  const res = wikiGetRelated(plantWiki(), { path: "concepts/relative/target.md" }); expect(res.ok).toBe(true); if (!res.ok) return;
  const sorted = (rows: Array<{ path: string; anchor: string }>) => rows.map(({ path, anchor }) => ({ path, anchor })).sort((a, b) => a.path.localeCompare(b.path));
  expect(sorted(res.outbound)).toEqual([{ path: "concepts/relative/nested/child.md", anchor: "./nested/child" }, { path: "concepts/relative/source.md", anchor: "./source" }]);
  expect(sorted(res.inbound)).toEqual([{ path: "concepts/relative/nested/child.md", anchor: "../target" }, { path: "concepts/relative/source.md", anchor: "./target" }]);
});
test("catalog omits private pages and respects page type", () => {
  const ctx = plantWiki(); const paths = wikiList(ctx).pages.map((p) => p.path);
  for (const p of ["concepts/alpha.md", "entities/thing.md", "drafts/pub.md"]) expect(paths).toContain(p);
  for (const p of ["ideas/secret-idea.md", "readouts/ro.md"]) expect(paths).not.toContain(p);
  const entities = wikiList(ctx, { type: "entity" }); expect(entities.pages.every((p) => p.type === "entity")).toBe(true);
  expect(entities.pages.map((p) => p.path)).toContain("entities/thing.md");
});
