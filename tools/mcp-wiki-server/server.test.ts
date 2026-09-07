import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Raw JSON-RPC, not the SDK client: every stdout line must be a protocol frame.
type Rpc = { jsonrpc?: string; id?: number; result?: { serverInfo?: { name?: string }; tools?: Array<{ name: string }>; content?: Array<{ text: string }> } };
const frame = (message: unknown): string => JSON.stringify(message) + "\n";
async function collect(reader: ReadableStreamDefaultReader<Uint8Array>, want: number[], timeoutMs: number): Promise<{ lines: string[]; byId: Map<number, Rpc> }> {
  const decoder = new TextDecoder(); let buffer = ""; const lines: string[] = []; const byId = new Map<number, Rpc>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !want.every((id) => byId.has(id))) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = await Promise.race([reader.read(), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())); })]);
    if (timer) clearTimeout(timer);
    if (read === null || read.done) break;
    buffer += decoder.decode(read.value, { stream: true }); let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (!line) continue;
      lines.push(line); const parsed = JSON.parse(line) as Rpc;
      expect(parsed.jsonrpc).toBe("2.0"); if (typeof parsed.id === "number") byId.set(parsed.id, parsed);
    }
  }
  for (const id of want) expect(byId.has(id)).toBe(true);
  return { lines, byId };
}
function payload(message: Rpc | undefined): { ok?: boolean; results?: Array<{ path: string }>; reason?: string } {
  const text = message?.result?.content?.[0]?.text; if (!text) throw new Error("Missing MCP content"); return JSON.parse(text);
}
test("stdio clean framing, all 11 tools, search/regex round trips, and private gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-stdio-test-"));
  mkdirSync(join(dir, "concepts")); mkdirSync(join(dir, "ideas"));
  writeFileSync(join(dir, "concepts/alpha.md"), "---\ntitle: Alpha\nvisibility: public\n---\nbanana pattern lives here.\n");
  writeFileSync(join(dir, "ideas/secret.md"), "---\ntitle: Secret\n---\nbanana secret.\n");
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, WIKI_DIR: dir, WIKI_FTS_DB: join(dir, ".wiki-fts5.db"), MCP_SCOPE: "public" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  try {
    proc.stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } }));
    await proc.stdin.flush();
    const first = await collect(reader, [1], 10000); expect(first.byId.get(1)?.result?.serverInfo?.name).toBe("llm-wiki");
    proc.stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));
    proc.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    proc.stdin.write(frame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wiki_search", arguments: { query: "banana", limit: 10 } } }));
    proc.stdin.write(frame({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "wiki_get_page", arguments: { path: "ideas/secret.md" } } }));
    proc.stdin.write(frame({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "wiki_regex_search", arguments: { pattern: "banana\\s+\\w+", limit: 10 } } }));
    await proc.stdin.flush(); const rest = await collect(reader, [2, 3, 4, 5], 10000);
    expect((rest.byId.get(2)?.result?.tools ?? []).map((tool) => tool.name).sort()).toEqual([
      "wiki_audit_visibility", "wiki_get_page", "wiki_get_related", "wiki_get_sources", "wiki_health_summary", "wiki_lint_summary", "wiki_list", "wiki_regex_search", "wiki_resolve", "wiki_search", "wiki_search_and_read" ]);
    const search = payload(rest.byId.get(3)); expect(search.results?.map((r) => r.path)).toEqual(["concepts/alpha.md"]);
    expect(payload(rest.byId.get(4)).ok).toBe(false);
    const regex = payload(rest.byId.get(5)); expect(regex.ok).toBe(true); expect(regex.results?.map((r) => r.path)).toEqual(["concepts/alpha.md"]);
    expect(JSON.stringify(regex)).not.toContain("banana secret");
  } finally { proc.kill(); await proc.exited; reader.releaseLock(); rmSync(dir, { recursive: true, force: true }); }
}, 30000);
