import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const TOOLS_DIR = import.meta.dir;
const FORBIDDEN_LOCAL_STATE = [
  "node_modules",
  "package-lock.json",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function runtimeSources(dir: string): string[] {
  const sources: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;

    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sources.push(...runtimeSources(path));
    } else if (entry.name.endsWith(".ts")) {
      sources.push(path);
    }
  }

  return sources;
}

function findMcpDirs(dir: string): string[] {
  const dirs: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.name.includes("mcp")) {
      dirs.push(path);
      continue;
    }
    dirs.push(...findMcpDirs(path));
  }

  return dirs;
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/", 1)[0];
}

test("wiki MCPs dynamically resolve exact npm dependencies without vault node_modules", () => {
  const mcpDirs = findMcpDirs(TOOLS_DIR);
  const violations: string[] = [];

  expect(mcpDirs.length).toBeGreaterThan(0);

  for (const mcpDir of mcpDirs) {
    const manifestPath = join(mcpDir, "package.json");
    const lockPath = join(mcpDir, "bun.lock");

    if (!existsSync(manifestPath)) {
      violations.push(`${relative(TOOLS_DIR, manifestPath)} must exist`);
      continue;
    }
    if (!existsSync(lockPath)) {
      violations.push(`${relative(TOOLS_DIR, lockPath)} must exist`);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = manifest.dependencies ?? {};
    for (const [name, version] of Object.entries(dependencies)) {
      if (!EXACT_VERSION.test(version)) {
        violations.push(`${relative(TOOLS_DIR, manifestPath)} pins ${name} as "${version}"`);
      }
    }

    for (const name of FORBIDDEN_LOCAL_STATE) {
      const path = join(mcpDir, name);
      if (existsSync(path)) {
        violations.push(`${relative(TOOLS_DIR, path)} must not exist`);
      }
    }

    for (const sourcePath of runtimeSources(mcpDir)) {
      const source = readFileSync(sourcePath, "utf8");
      const importPattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
      const runtimeSource = !sourcePath.endsWith(".test.ts");
      const dynamicImports = new Set(
        [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)].map((match) => match[1]),
      );

      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (
          specifier.startsWith(".")
          || specifier.startsWith("node:")
          || specifier.startsWith("bun:")
        ) {
          continue;
        }
        const dependency = packageName(specifier);
        if (!dependencies[dependency]) {
          violations.push(
            `${relative(TOOLS_DIR, sourcePath)} imports undeclared npm package "${specifier}"`,
          );
        }
        if (runtimeSource && !dynamicImports.has(specifier)) {
          violations.push(
            `${relative(TOOLS_DIR, sourcePath)} must dynamically import npm package "${specifier}"`,
          );
        }
      }
    }
  }

  expect(violations).toEqual([]);
});
