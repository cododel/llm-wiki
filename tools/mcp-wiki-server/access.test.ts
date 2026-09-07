import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { authorize, isServable, readServable, resolveSafe, redact, parseVisibility, type AccessCtx } from "./access.ts";
const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }); });
function mkWiki(): string { const dir = mkdtempSync(join(tmpdir(), "mcp-access-test-")); cleanup.push(dir); return dir; }
function w(root: string, rel: string, content = "---\ntitle: x\n---\nbody\n"): void {
  const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content);
}
const pub = (dir: string): AccessCtx => ({ wikiDir: dir, scope: "public" });
const adm = (dir: string): AccessCtx => ({ wikiDir: dir, scope: "admin" });
const published = "---\ntitle: x\nvisibility: public\n---\nbody\n";

test("resolveSafe rejects traversal, absolute, Windows, NUL, and non-md paths", () => {
  const dir = mkWiki(); w(dir, "concepts/foo.md"); w(dir, "concepts/note.txt");
  for (const p of ["../secrets.md", "/etc/passwd", "concepts/../../x.md", "concepts/foo\0.md", "concepts/note.txt", "C:\\notes\\a.md", "C:/notes/a.md"]) expect(resolveSafe(pub(dir), p).ok).toBe(false);
  expect(resolveSafe(pub(dir), "concepts/foo.md").ok).toBe(true);
});
test("operational and packaging layers remain denied even with public metadata and admin scope", () => {
  const dir = mkWiki();
  for (const p of ["tools/x.md", "templates/x.md", "examples/x.md", "docs/x.md", ".github/x.md", "_archive/old.md", ".git/hooks.md", ".obsidian/note.md", ".hermes/x.md", ".claude/x.md", "node_modules/x.md", ".factcheck-log.md", ".wiki-fts5.db.md"]) {
    w(dir, p, published); expect(authorize(adm(dir), p).ok).toBe(false); expect(authorize(pub(dir), p).ok).toBe(false);
  }
});
test("admin serves all non-blocklisted content layers without publication", () => {
  const dir = mkWiki();
  for (const p of ["ideas/secret.md", "raw/docs/source.md", "concepts/a.md", "README.md"]) {
    w(dir, p); expect(authorize(adm(dir), p).ok).toBe(true);
  }
});
test("every layer requires explicit publication, including formerly public layers", () => {
  const dir = mkWiki();
  for (const rel of ["concepts/foo.md", "adr/a.md", "entities/e.md", "comparisons/c.md", "pages/p.md", "queries/q.md", "ideas/secret.md", "notes/n.md", "raw/r.md", "readouts/ro.md", "random/x.md", "index.md", "README.md"]) {
    w(dir, rel); expect(isServable(pub(dir), rel)).toBe(false);
    w(dir, rel, published); expect(isServable(pub(dir), rel)).toBe(true);
  }
});
test("explicit private denies a concept while explicit public can expose an idea/readout", () => {
  const dir = mkWiki();
  w(dir, "ideas/open.md", published); w(dir, "readouts/open.md", published);
  w(dir, "concepts/hidden.md", "---\ntitle: x\nvisibility: private\n---\nbody\n");
  expect(isServable(pub(dir), "ideas/open.md")).toBe(true);
  expect(isServable(pub(dir), "readouts/open.md")).toBe(true);
  expect(isServable(pub(dir), "concepts/hidden.md")).toBe(false);
});
test("published draft status is not public authorization", () => {
  const dir = mkWiki();
  for (const status of ["draft", "ready", "published"]) {
    const p = `drafts/${status}.md`;
    w(dir, p, `---\ntitle: x\nstatus: ${status}\n---\nbody\n`); expect(isServable(pub(dir), p)).toBe(false);
  }
  w(dir, "drafts/open.md", "---\ntitle: x\nstatus: published\nvisibility: public\n---\nbody\n");
  expect(isServable(pub(dir), "drafts/open.md")).toBe(true);
});
test("malformed or duplicated publication metadata fails closed", () => {
  const dir = mkWiki();
  for (const text of ["visibility: public\nbody", "---\nvisibility: public\nbody", "---\nvisibility: public\nvisibility: private\n---\nbody", "---\nvisibility: public\nvisibility: public\n---\nbody", "---\nvisibility: yes\n---\nbody", "---\nvisibility: public\ninvalid yaml line\n---\nbody"]) {
    w(dir, "concepts/x.md", text); expect(isServable(pub(dir), "concepts/x.md")).toBe(false);
  }
});
test("case variants cannot make an unmarked private page public", () => {
  const dir = mkWiki(); w(dir, "ideas/secret.md");
  const r = resolveSafe(pub(dir), "IDEAS/secret.md");
  if (r.ok) expect(isServable(pub(dir), "IDEAS/secret.md")).toBe(false);
});
test("file symlink classification follows its real target", () => {
  const dir = mkWiki(); w(dir, "ideas/secret.md"); mkdirSync(join(dir, "concepts"), { recursive: true });
  symlinkSync("../ideas/secret.md", join(dir, "concepts/link.md"));
  const r = resolveSafe(pub(dir), "concepts/link.md"); expect(r.ok).toBe(true);
  if (r.ok) expect(r.relPath).toBe("ideas/secret.md");
  expect(isServable(pub(dir), "concepts/link.md")).toBe(false);
});
test("directory symlinks do not publish unmarked targets", () => {
  const dir = mkWiki(); w(dir, "ideas/secret.md"); mkdirSync(join(dir, "concepts"), { recursive: true });
  symlinkSync("../ideas", join(dir, "concepts/sub")); expect(isServable(pub(dir), "concepts/sub/secret.md")).toBe(false);
});
test("symlink escape and symlink into packaging are rejected in all scopes", () => {
  const dir = mkWiki(); const outside = mkWiki(); w(outside, "source.md", published); w(dir, "tools/internal.md", published);
  mkdirSync(join(dir, "concepts"), { recursive: true });
  symlinkSync(join(outside, "source.md"), join(dir, "concepts/escape.md"));
  symlinkSync("../tools/internal.md", join(dir, "concepts/blocked.md"));
  for (const ctx of [pub(dir), adm(dir)]) for (const p of ["concepts/escape.md", "concepts/blocked.md"]) expect(authorize(ctx, p).ok).toBe(false);
});
test("redaction scrubs body secrets after explicit publication", () => {
  const dir = mkWiki();
  w(dir, "concepts/leaky.md", published + "key sk-abcdEFGH1234567890xyz here\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nauth: Bearer abcdefgh12345678\n");
  const res = readServable(pub(dir), "concepts/leaky.md"); expect(res.ok).toBe(true);
  if (res.ok) {
    for (const secret of ["sk-abcdEFGH1234567890xyz", "BEGIN OPENSSH PRIVATE KEY", "AAAA", "Bearer abcdefgh12345678"]) expect(res.markdown).not.toContain(secret);
    expect(res.markdown).toContain("[REDACTED]");
  }
});
test("redact is a no-op on clean prose", () => { expect(redact("just normal wiki prose")).toBe("just normal wiki prose"); });
test("publication metadata handles blank lines and quoted values", () => {
  const meta = parseVisibility('---\n\ntitle: "X"\nvisibility: "public"\nconfidence: high\ncontested: true\n---\nbody');
  expect(meta.visibility).toBe("public"); expect(meta.confidence).toBe("high"); expect(meta.contested).toBe(true);
});
