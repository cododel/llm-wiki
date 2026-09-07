import { join, resolve } from "node:path";

/** Tool checkout and selected content vault are independent locations. */
export const TOOL_ROOT = resolve(import.meta.dir, "../..");

export function resolveWikiDir(value = process.env.WIKI_DIR): string {
  return resolve(value?.trim() || TOOL_ROOT);
}

export function resolveDbPath(wikiDir = resolveWikiDir(), value = process.env.WIKI_FTS_DB): string {
  return resolve(value?.trim() || join(wikiDir, ".wiki-fts5.db"));
}

/** Packaging directories must never become knowledge, even with public metadata. */
export const PACKAGING_DIRS = new Set(["tools", "templates", "examples", "docs", ".github"]);
