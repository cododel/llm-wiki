import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { VALID_TYPES } from "./wiki_health.ts";
import { shouldIndexPath } from "./fts5/wiki-search.ts";
import { listServable } from "./mcp-wiki-server/access.ts";
import { TOOL_ROOT } from "./lib/paths.ts";

const AUTHORABLE_TYPES = [
  "raw-source", "readout", "entity", "concept", "comparison", "query",
  "idea", "note", "article-draft", "post-draft", "meta", "adr",
].sort();

function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

test("every supported content type has exactly one page template", () => {
  const templates = readdirSync(join(TOOL_ROOT, "templates"))
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => name.replace(/\.md$/, ""))
    .sort();
  expect([...VALID_TYPES].sort()).toEqual(AUTHORABLE_TYPES);
  expect(templates).toEqual(AUTHORABLE_TYPES);
});

test("packaging and demo content stay outside the live index and public surface", () => {
  expect(shouldIndexPath("templates/concept.md")).toBe(false);
  expect(shouldIndexPath("examples/demo-wiki/concepts/source-preservation.md")).toBe(false);
  const exposed = listServable({ wikiDir: TOOL_ROOT, scope: "public" }).map((entry) => entry.path);
  expect(exposed.some((path) => path.startsWith("templates/") || path.startsWith("examples/"))).toBe(false);
});

test("the demo publishes only its explicitly public concept", () => {
  const demo = join(TOOL_ROOT, "examples", "demo-wiki");
  expect(listServable({ wikiDir: demo, scope: "public" }).map((entry) => entry.path)).toEqual([
    "concepts/source-preservation.md",
  ]);
});

test("documented package entrypoints and examples exist", () => {
  for (const rel of [
    "tools/verify.ts",
    "tools/factcheck/README.md",
    "tools/mcp-wiki-server/README.md",
    "tools/mcp-wiki-server/ecosystem.config.example.cjs",
    ".env.example",
    "examples/deployment/Caddyfile.example",
  ]) expect(existsSync(join(TOOL_ROOT, rel))).toBe(true);
});

test("the PM2 example is parameterized and admin configuration fails closed", () => {
  const config = join(TOOL_ROOT, "tools/mcp-wiki-server/ecosystem.config.example.cjs");
  const baseEnv = { ...process.env } as Record<string, string>;
  for (const name of [
    "MCP_OAUTH_ISSUER", "MCP_OAUTH_RESOURCE", "MCP_OAUTH_DB",
    "MCP_OAUTH_OWNER_USERNAME", "MCP_OAUTH_PASSWORD_HASH_FILE",
    "MCP_OAUTH_PRIVATE_KEY_FILE", "MCP_OAUTH_PUBLIC_KEY_FILE",
  ]) delete baseEnv[name];
  Object.assign(baseEnv, {
    WIKI_DIR: TOOL_ROOT,
    WIKI_FTS_DB: "/tmp/llm-wiki-example-fts.sqlite",
    MCP_PUBLIC_ALLOWED_HOSTS: "public.example.invalid",
    MCP_ADMIN_ALLOWED_HOSTS: "admin.example.invalid",
  });

  const incomplete = Bun.spawnSync({
    cmd: [process.execPath, config],
    cwd: TOOL_ROOT,
    env: baseEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(incomplete.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(incomplete.stderr)).toContain("MCP_OAUTH_ISSUER is required");

  const complete = Bun.spawnSync({
    cmd: [process.execPath, "-e", `const config = require(${JSON.stringify(config)}); console.log(JSON.stringify(config.apps.map((app) => app.env.MCP_SCOPE)))`],
    cwd: TOOL_ROOT,
    env: {
      ...baseEnv,
      MCP_OAUTH_ISSUER: "https://admin.example.invalid",
      MCP_OAUTH_RESOURCE: "https://admin.example.invalid/mcp",
      MCP_OAUTH_DB: "/tmp/llm-wiki-example-oauth.sqlite",
      MCP_OAUTH_OWNER_USERNAME: "owner",
      MCP_OAUTH_PASSWORD_HASH_FILE: "/tmp/llm-wiki-example-password-hash",
      MCP_OAUTH_PRIVATE_KEY_FILE: "/tmp/llm-wiki-example-private-key",
      MCP_OAUTH_PUBLIC_KEY_FILE: "/tmp/llm-wiki-example-public-key",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(complete.exitCode).toBe(0);
  expect(new TextDecoder().decode(complete.stdout).trim()).toBe('["public","admin"]');
});

test("tracked template files contain no source-vault or machine-specific identity", () => {
  const forbidden = [
    ["/root", "wiki"].join("/"),
    ["wiki", "codo", "del"].join("."),
    ["codo", "del-ghostwriting"].join(""),
    ["alex", "ander"].join(""),
  ];
  const hits: string[] = [];
  for (const path of filesUnder(TOOL_ROOT)) {
    const text = readFileSync(path, "utf8").toLowerCase();
    for (const needle of forbidden) if (text.includes(needle.toLowerCase())) hits.push(`${relative(TOOL_ROOT, path)}: ${needle}`);
  }
  expect(hits).toEqual([]);
});
