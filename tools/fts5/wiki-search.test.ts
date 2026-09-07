import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildMatchExpr,
  extractWikilinks,
  parseArgs,
  parseFrontmatter,
  parseMarkdownPage,
  resolveType,
  searchIndex,
  shouldIndexPath,
  statusIndex,
  updateIndex,
} from "./wiki-search.ts";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempWiki(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "wiki-fts5-test-"));
  cleanup.push(dir);
  const dbPath = join(dir, ".wiki-fts5.db");
  return { dir, dbPath };
}

function writePage(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

test("parseArgs parses explicit search command", () => {
  expect(parseArgs(["search", "память агента", "--limit", "5", "--json"])).toMatchObject({
    cmd: "search",
    query: "память агента",
    limit: 5,
    json: true,
  });
});

test("type inference exposes only the supported draft sublayers", () => {
  expect(resolveType("drafts/articles/example.md")).toBe("article-draft");
  expect(resolveType("drafts/posts/example.md")).toBe("post-draft");
  expect(resolveType("drafts/example.md")).toBe("unknown");
});

test("parseArgs treats first non-command as search query", () => {
  expect(parseArgs(["RLM", "--folder", "concepts"])).toMatchObject({
    cmd: "search",
    query: "RLM",
    folder: "concepts",
  });
});

test("parseArgs supports search mode", () => {
  expect(parseArgs(["search", "slot filling pressure error", "--mode", "broad", "--json"])).toMatchObject({
    cmd: "search",
    query: "slot filling pressure error",
    mode: "broad",
    json: true,
  });
});

test("buildMatchExpr quotes terms safely and supports prefix/tag/raw/aliases", () => {
  expect(buildMatchExpr("память агента", { prefix: false, raw: false, tag: "" })).toBe('("память" OR "памяти") AND ("агента" OR "агент")');
  expect(buildMatchExpr("канбан", { prefix: false, raw: false, tag: "" })).toBe('("канбан" OR "kanban")');
  expect(buildMatchExpr("директус права", { prefix: false, raw: false, tag: "" })).toBe('("директус" OR "directus") AND "права"');
  expect(buildMatchExpr("какие есть заметки про память агента", { prefix: false, raw: false, tag: "" })).toBe('("память" OR "памяти") AND ("агента" OR "агент")');
  expect(buildMatchExpr("slot filling pressure error", { prefix: false, raw: false, tag: "", mode: "broad" })).toBe('"slot" OR "filling" OR "pressure" OR "error"');
  expect(buildMatchExpr("obsid", { prefix: true, raw: false, tag: "" })).toBe('"obsid"*');
  expect(buildMatchExpr('title:"RLM" OR body:"recursive"', { prefix: false, raw: true, tag: "" })).toBe('title:"RLM" OR body:"recursive"');
  expect(buildMatchExpr('title:"RLM" OR body:"recursive"', { prefix: false, raw: true, tag: "rag" })).toBe('(title:"RLM" OR body:"recursive") AND tags:"rag"');
  expect(buildMatchExpr("memory", { prefix: false, raw: false, tag: "rag" })).toBe('("memory") AND tags:"rag"');
});

test("parseFrontmatter supports inline and multiline tags", () => {
  expect(parseFrontmatter('title: "RLM — Recursive Language Models"\ntype: concept\ntags: [rag, memory, architecture]\n')).toEqual({
    title: "RLM — Recursive Language Models",
    type: "concept",
    tags: ["rag", "memory", "architecture"],
  });

  expect(parseFrontmatter("title: Multi\ntags:\n  - wiki\n  - memory\ntype: note\n")).toEqual({
    title: "Multi",
    type: "note",
    tags: ["wiki", "memory"],
  });
});

test("extractWikilinks handles aliases, headings, embeds, and hyphen split terms", () => {
  expect(extractWikilinks("[[wiki-memory-approaches|подходы]] ![[raw/assets/x.png]] [[concepts/rlm-recursive-language-models#How]]")).toEqual([
    "wiki-memory-approaches",
    "wiki memory approaches",
    "raw/assets/x.png",
    "x.png",
    "concepts/rlm-recursive-language-models",
    "rlm-recursive-language-models",
    "rlm recursive language models",
  ]);
});

test("parseMarkdownPage extracts searchable fields", () => {
  const { dir } = tempWiki();
  writePage(dir, "concepts/rlm-recursive-language-models.md", `---
title: "RLM — Recursive Language Models"
type: concept
tags: [rag, memory, architecture]
---

# RLM — Recursive Language Models

См. [[wiki-memory-approaches]] и [[llm-wiki-pattern]].

## RLM vs RAG
Body.
`);

  const page = parseMarkdownPage(join(dir, "concepts/rlm-recursive-language-models.md"), dir);
  expect(page.title).toContain("RLM — Recursive Language Models");
  expect(page.type).toBe("concept");
  expect(page.tags).toEqual(["rag", "memory", "architecture"]);
  expect(page.headings).toContain("RLM vs RAG");
  expect(page.wikilinks).toContain("wiki-memory-approaches");
  expect(page.body).not.toContain("tags: [rag");
  expect(page.path).toBe("concepts/rlm-recursive-language-models.md");
  expect(page.folder).toBe("concepts");
});

test("path filtering and type resolution match wiki policy", () => {
  expect(shouldIndexPath("concepts/wiki-memory-approaches.md")).toBe(true);
  expect(shouldIndexPath("raw/user-notes/source.md")).toBe(true);
  expect(shouldIndexPath(".obsidian/workspace.md")).toBe(false);
  expect(shouldIndexPath("tools/fts5/README.md")).toBe(false);
  expect(shouldIndexPath("index.md")).toBe(false);
  expect(shouldIndexPath("log.md")).toBe(false);
  expect(shouldIndexPath("log-2026-06-24.md")).toBe(false);
  expect(shouldIndexPath("AGENTS.md")).toBe(true);
  expect(shouldIndexPath("SCHEMA.md")).toBe(true);
  expect(shouldIndexPath(".factcheck-log.md")).toBe(false);
  expect(shouldIndexPath("readouts/2026-06-28-factcheck-abc-batch-01.md")).toBe(false);
  expect(shouldIndexPath("readouts/2026-06-28-factcheck-abc-summary.md")).toBe(true);
  expect(resolveType("concepts/foo.md")).toBe("concept");
  expect(resolveType("raw/user-notes/foo.md")).toBe("raw-source");
  expect(resolveType("drafts/posts/foo.md")).toBe("post-draft");
  expect(resolveType("AGENTS.md")).toBe("meta");
});

test("build, incremental update, removal, and search work end-to-end", () => {
  const { dir, dbPath } = tempWiki();
  writePage(dir, "concepts/wiki-memory-approaches.md", `---
title: "Подходы к памяти агента"
type: concept
tags: [wiki, memory, architecture]
---
# Подходы к памяти агента

FTS5 помогает искать память агента. См. [[rlm-recursive-language-models]].
`);
  writePage(dir, "concepts/rlm-recursive-language-models.md", `---
title: RLM
type: concept
tags: [rag, memory]
---
# Recursive Language Models

RLM — альтернатива RAG.
`);
  writePage(dir, "notes/other.md", `---
title: Другая заметка
type: note
tags: [misc]
---
# Другая заметка

Нерелевантный текст про RLM.
`);
  writePage(dir, ".factcheck-log.md", "операционный лог память агента");

  expect(updateIndex({ wikiDir: dir, dbPath, full: true, quiet: true })).toMatchObject({ indexed: 3, removed: 0, total: 3 });
  expect(statusIndex({ wikiDir: dir, dbPath })).toMatchObject({ exists: true, pages: 3 });

  const memoryResults = searchIndex("память агента", { wikiDir: dir, dbPath, limit: 5 });
  expect(memoryResults[0].path).toBe("concepts/wiki-memory-approaches.md");
  expect(memoryResults[0].snippet).toContain("«память»");

  const conceptResults = searchIndex("memory", { wikiDir: dir, dbPath, type: "concept", limit: 10 });
  expect(conceptResults.every((r) => r.type === "concept")).toBe(true);

  const linkResults = searchIndex("rlm", { wikiDir: dir, dbPath, folder: "concepts", limit: 10 });
  expect(linkResults.map((r) => r.path)).toContain("concepts/wiki-memory-approaches.md");
  expect(linkResults.map((r) => r.path)).toContain("concepts/rlm-recursive-language-models.md");

  const rawTagResults = searchIndex('body:"RLM"', { wikiDir: dir, dbPath, raw: true, tag: "rag", limit: 10 });
  expect(rawTagResults.map((r) => r.path)).toEqual(["concepts/rlm-recursive-language-models.md"]);

  writePage(dir, "notes/other.md", `---
title: Другая заметка
type: note
tags: [misc]
---
# Другая заметка

Теперь здесь есть Directus права.
`);
  const updateStats = updateIndex({ wikiDir: dir, dbPath, quiet: true });
  expect(updateStats.indexed).toBe(1);

  unlinkSync(join(dir, "notes/other.md"));
  const removeStats = updateIndex({ wikiDir: dir, dbPath, quiet: true });
  expect(removeStats.removed).toBe(1);
  expect(statusIndex({ wikiDir: dir, dbPath }).pages).toBe(2);
});

test("auto mode falls back to broad search when a natural-language query has an extra missing token", () => {
  const { dir, dbPath } = tempWiki();
  writePage(dir, "drafts/posts/slot-filling-pressure.md", `---
title: Slot Filling Pressure
type: post-draft
tags: [content]
---
# Slot Filling Pressure

Slot filling pressure is a prompt failure mode.
`);

  updateIndex({ wikiDir: dir, dbPath, full: true, quiet: true });

  expect(searchIndex("slot filling pressure error", { wikiDir: dir, dbPath, mode: "strict", limit: 5 })).toEqual([]);
  expect(searchIndex("slot filling pressure error", { wikiDir: dir, dbPath, mode: "auto", limit: 5 })[0].path)
    .toBe("drafts/posts/slot-filling-pressure.md");
});
