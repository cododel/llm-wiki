// Single authorization chokepoint. Classify real paths, never frontmatter type.
// All returned bodies pass through readServable; publication is explicit opt-in.
import { realpathSync, readFileSync, statSync } from "node:fs";
import { resolve as pathResolve, relative, isAbsolute, sep, join } from "node:path";
import { scanMarkdownFiles, parseMarkdownPage } from "../fts5/wiki-search.ts";
import { parseFrontmatter } from "../wiki_tags.ts";
import { PACKAGING_DIRS } from "../lib/paths.ts";

export type Scope = "admin" | "public";
export type AccessCtx = { wikiDir: string; scope: Scope };
export type Decision = { allowed: true } | { allowed: false; reason: string };
export type AuthOk = { ok: true; relPath: string; absPath: string };
export type AuthErr = { ok: false; reason: string };
export type VisMeta = { visibility?: "public" | "private"; status?: string; confidence?: string; contested?: boolean };
export type ServableEntry = { path: string; title: string; type: string; tags: string[]; confidence?: string; contested?: boolean };
const BLOCK_SEGMENTS = new Set([".git", ".obsidian", ".hermes", ".claude", "_archive", "tools", "node_modules"]);

export function resolveSafe(ctx: AccessCtx, input: string): AuthOk | AuthErr {
  if (!input || input.includes("\0") || input.includes("\\")) return { ok: false, reason: "invalid path" };
  if (isAbsolute(input) || /^[A-Za-z]:/.test(input)) return { ok: false, reason: "absolute path rejected" };
  const abs = pathResolve(ctx.wikiDir, input);
  const lexRel = relative(ctx.wikiDir, abs);
  if (lexRel === "" || lexRel === ".." || lexRel.startsWith(".." + sep) || isAbsolute(lexRel)) return { ok: false, reason: "outside wiki" };
  if (isBlocked(lexRel.split(sep).join("/"))) return { ok: false, reason: "blocklisted" };
  let realAbs: string; let realWiki: string;
  try {
    realAbs = realpathSync(abs); realWiki = realpathSync(ctx.wikiDir);
    if (!statSync(realAbs).isFile()) return { ok: false, reason: "not a markdown page" };
  } catch { return { ok: false, reason: "not found" }; }
  const realRel = relative(realWiki, realAbs);
  if (realRel === "" || realRel === ".." || realRel.startsWith(".." + sep) || isAbsolute(realRel)) return { ok: false, reason: "symlink escape" };
  if (!realRel.toLowerCase().endsWith(".md")) return { ok: false, reason: "not a markdown page" };
  return { ok: true, absPath: realAbs, relPath: realRel.split(sep).join("/") };
}
/** Only parseable, non-duplicated top-level publication metadata can opt in. */
export function parseVisibility(text: string): VisMeta {
  const parsed = parseFrontmatter(text);
  if (parsed.status !== "ok") return {};
  const fm = parsed.data; const out: VisMeta = {};
  if (fm.visibility === "public" || fm.visibility === "private") out.visibility = fm.visibility;
  if (typeof fm.status === "string") out.status = fm.status.toLowerCase();
  if (typeof fm.confidence === "string") out.confidence = fm.confidence.toLowerCase();
  if (typeof fm.contested === "string") out.contested = fm.contested.toLowerCase() === "true";
  return out;
}
export function readVisibility(absPath: string): VisMeta {
  try { return parseVisibility(readFileSync(absPath, "utf8")); } catch { return {}; }
}
export function isBlocked(relPath: string): boolean {
  const segs = relPath.split("/").map((seg) => seg.toLowerCase());
  if (PACKAGING_DIRS.has(segs[0])) return true;
  if (segs.some((seg) => BLOCK_SEGMENTS.has(seg))) return true;
  const base = segs[segs.length - 1];
  return base.startsWith(".factcheck") || base.startsWith(".wiki-fts5.db");
}
export function canServe(ctx: AccessCtx, relPath: string, absPath: string): Decision {
  if (isBlocked(relPath)) return { allowed: false, reason: "blocklisted" };
  if (ctx.scope === "admin") return { allowed: true };
  // Folder and lifecycle status never grant publication rights.
  return readVisibility(absPath).visibility === "public"
    ? { allowed: true } : { allowed: false, reason: "explicit visibility: public required" };
}
export function authorize(ctx: AccessCtx, input: string): AuthOk | AuthErr {
  const safe = resolveSafe(ctx, input);
  if (!safe.ok) return safe;
  const decision = canServe(ctx, safe.relPath, safe.absPath);
  return decision.allowed ? safe : { ok: false, reason: decision.reason };
}
export function isServable(ctx: AccessCtx, input: string): boolean { return authorize(ctx, input).ok; }
const REDACTIONS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /ssh-(?:rsa|ed25519|dss) AAAA[0-9A-Za-z+/]+=*/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
];
export function redact(text: string): string {
  let out = text; for (const re of REDACTIONS) out = out.replace(re, "[REDACTED]"); return out;
}
export function readServable(ctx: AccessCtx, input: string): { ok: true; relPath: string; markdown: string; meta: VisMeta } | AuthErr {
  const auth = authorize(ctx, input);
  if (!auth.ok) return auth;
  let text: string;
  try { text = readFileSync(auth.absPath, "utf8"); } catch { return { ok: false, reason: "not found" }; }
  const meta = parseVisibility(text);
  // Recheck the exact body being returned if the file changed since authorization.
  if (ctx.scope !== "admin" && meta.visibility !== "public") return { ok: false, reason: "not found" };
  return { ok: true, relPath: auth.relPath, markdown: redact(text), meta };
}
export function listServable(ctx: AccessCtx, opts: { type?: string; tag?: string; folder?: string } = {}): ServableEntry[] {
  const files = scanMarkdownFiles(ctx.wikiDir);
  const wantFolder = (opts.folder ?? "").replace(/\/+$/, "");
  const out: ServableEntry[] = [];
  for (const relPath of files.keys()) {
    const auth = authorize(ctx, relPath);
    if (!auth.ok) continue;
    if (wantFolder) {
      const folder = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
      if (folder !== wantFolder && !folder.startsWith(wantFolder + "/")) continue;
    }
    const page = parseMarkdownPage(join(ctx.wikiDir, relPath), ctx.wikiDir);
    if (opts.type && page.type !== opts.type) continue;
    if (opts.tag && !page.tags.includes(opts.tag)) continue;
    const meta = readVisibility(auth.absPath);
    if (ctx.scope !== "admin" && meta.visibility !== "public") continue;
    out.push({ path: relPath, title: redact(page.title), type: page.type, tags: page.tags.map(redact),
      ...(meta.confidence ? { confidence: meta.confidence } : {}), ...(meta.contested ? { contested: true } : {}) });
  }
  return out;
}
