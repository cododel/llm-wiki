#!/usr/bin/env bun
// Install the frozen dependency graph only in OS temp. Never create vault-local
// node_modules, even when tests fail. No source-vault content is copied.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_ROOT } from "../lib/paths.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "llm-wiki-mcp-test-"));
const tempTools = join(tempRoot, "tools");
const tempMcp = join(tempTools, "mcp-wiki-server");
function run(args: string[], cwd: string, extra: Record<string, string> = {}): void {
  const env = { ...process.env, ...extra };
  delete env.WIKI_DIR; delete env.WIKI_FTS_DB; delete env.MCP_SCOPE;
  const result = Bun.spawnSync({ cmd: [process.execPath, ...args], cwd, env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`bun ${args.join(" ")} failed with exit code ${result.exitCode}`);
}
try {
  cpSync(join(TOOL_ROOT, "tools"), tempTools, { recursive: true, filter: (source) => !source.split(/[\\/]/).includes("node_modules") });
  run(["install", "--frozen-lockfile", "--ignore-scripts"], tempMcp);
  run(["test", "--timeout", "30000", tempMcp], tempRoot, { WIKI_TEST_REPO: TOOL_ROOT });
} finally { rmSync(tempRoot, { recursive: true, force: true }); }
