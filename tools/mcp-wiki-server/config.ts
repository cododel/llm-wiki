import { resolveDbPath, resolveWikiDir } from "../lib/paths.ts";
export type Scope = "admin" | "public";
const wikiDir = resolveWikiDir();
const scope: Scope = process.env.MCP_SCOPE === "admin" ? "admin" : "public";
export const CONFIG = Object.freeze({ wikiDir, dbPath: resolveDbPath(wikiDir), scope, overfetch: 4 });
