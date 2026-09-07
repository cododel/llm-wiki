#!/usr/bin/env bun
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_ROOT } from "./lib/paths.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "llm-wiki-verify-"));
const demoRoot = join(TOOL_ROOT, "examples", "demo-wiki");
const demoDb = join(tempRoot, "demo-fts.sqlite");

function environment(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env };
  for (const name of ["WIKI_DIR", "WIKI_FTS_DB", "MCP_SCOPE", "FACTCHECK_AUTO_COMMIT"]) delete env[name];
  return { ...env, ...extra } as Record<string, string>;
}

function run(label: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): string {
  process.stdout.write(`verify: ${label} ... `);
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd: options.cwd ?? TOOL_ROOT,
    env: environment(options.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) {
    console.log("failed");
    throw new Error(`${label} failed (${result.exitCode})\n${stdout}\n${stderr}`);
  }
  console.log("ok");
  return stdout;
}

function unwantedState(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") found.push(path);
        else visit(path);
      } else if (entry.name === ".wiki-fts5.db" || entry.name.startsWith(".wiki-fts5.db-") || entry.name.endsWith(".sqlite") || entry.name.includes(".sqlite-")) {
        found.push(path);
      }
    }
  };
  visit(root);
  return found;
}

try {
  run("standalone tools and package tests", ["test",
    "tools/mcp-runtime-policy.test.ts",
    "tools/fts5/wiki-search.test.ts",
    "tools/wiki_health.test.ts",
    "tools/wiki_lint.test.ts",
    "tools/wiki_tags.test.ts",
    "tools/factcheck/factcheck-trigger-source.test.ts",
    "tools/factcheck/factcheck-trigger.test.ts",
    "tools/template-package.test.ts",
  ]);
  run("isolated MCP, HTTP, and OAuth tests", ["run", "tools/mcp-wiki-server/test.ts"]);

  const rootEnv = { WIKI_DIR: TOOL_ROOT, WIKI_FTS_DB: join(tempRoot, "root-fts.sqlite") };
  run("empty-wiki health", ["run", "tools/wiki_health.ts", "--strict", "--json"], { env: rootEnv });
  run("empty-wiki tags", ["run", "tools/wiki_tags.ts", "validate", "--strict", "--json"], { env: rootEnv });
  run("empty-wiki lint", ["run", "tools/wiki_lint.ts", "--strict", "--json"], { env: rootEnv });

  const demoEnv = { WIKI_DIR: demoRoot, WIKI_FTS_DB: demoDb };
  run("demo health from a foreign cwd", ["run", join(TOOL_ROOT, "tools", "wiki_health.ts"), "--strict", "--json"], { cwd: tempRoot, env: demoEnv });
  run("demo tags from a foreign cwd", ["run", join(TOOL_ROOT, "tools", "wiki_tags.ts"), "validate", "--strict", "--json"], { cwd: tempRoot, env: demoEnv });
  run("demo lint from a foreign cwd", ["run", join(TOOL_ROOT, "tools", "wiki_lint.ts"), "--strict", "--json"], { cwd: tempRoot, env: demoEnv });
  run("demo FTS build from a foreign cwd", ["run", join(TOOL_ROOT, "tools", "fts5", "wiki-search.ts"), "build", "--json"], { cwd: tempRoot, env: demoEnv });
  const search = run("demo FTS search", ["run", join(TOOL_ROOT, "tools", "fts5", "wiki-search.ts"), "search", "source", "--json"], { cwd: tempRoot, env: demoEnv });
  if (!search.includes("concepts/source-preservation.md")) throw new Error("demo FTS search did not return the durable concept");
  const exposure = run("demo public exposure", ["run", join(TOOL_ROOT, "tools", "mcp-wiki-server", "audit-visibility.ts"), "--list"], { cwd: tempRoot, env: demoEnv });
  if (!exposure.includes("concepts/source-preservation.md") || exposure.includes("readouts/2026-01-02-source-preservation.md")) {
    throw new Error("demo public exposure does not match explicit visibility");
  }

  const leaked = unwantedState(TOOL_ROOT);
  if (leaked.length) throw new Error(`verification left forbidden local state:\n${leaked.join("\n")}`);
  if (!existsSync(join(TOOL_ROOT, ".env.example"))) throw new Error(".env.example is missing");
  console.log("verify: all checks passed");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
