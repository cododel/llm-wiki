import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_ROOT } from "../lib/paths.ts";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function run(cmd: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = Bun.spawnSync({ cmd, cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${result.exitCode})\n${stdout}\n${stderr}`);
  return stdout.trim();
}

function write(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function fixture(): { dir: string; timeoutBin: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "llm-wiki-factcheck-"));
  cleanup.push(dir);
  cpSync(join(TOOL_ROOT, "tools"), join(dir, "tools"), {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
  });
  write(dir, "SCHEMA.md", "# Schema\n\n## Tag Taxonomy\n\n### Tags\n- pattern, readout, evidence\n");
  write(dir, "index.md", "# Index\n\n- [[concepts/example]]\n");
  write(dir, "log.md", "# Log\n");
  write(dir, "concepts/example.md", "---\ntitle: Example\ntype: concept\ntags: [pattern]\nvisibility: private\n---\n# Example\n");
  const timeoutBin = join(dir, "fake-timeout.ts");
  writeFileSync(timeoutBin, `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const prompt = process.argv.at(-1) ?? "";
const match = /(?:Batch|Summary) readout path: (.+)/.exec(prompt);
if (!match) process.exit(2);
const output = match[1].trim();
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, "---\\ntitle: Generated factcheck\\ntype: readout\\nstatus: analyzed\\ntags: [readout, evidence]\\nsources: []\\nconfidence: medium\\nvisibility: private\\n---\\n# Generated factcheck\\n\\n## Checked files\\n\\n- [[concepts/example]]\\n");
`);
  chmodSync(timeoutBin, 0o755);
  run(["git", "init", "-q"], dir);
  run(["git", "config", "user.name", "Template Test"], dir);
  run(["git", "config", "user.email", "template@example.invalid"], dir);
  run(["git", "config", "commit.gpgsign", "false"], dir);
  run(["git", "add", "SCHEMA.md", "index.md", "log.md", "concepts/example.md"], dir);
  run(["git", "commit", "-qm", "test: seed fixture"], dir);
  return { dir, timeoutBin, head: run(["git", "rev-parse", "HEAD"], dir) };
}

function completeFactcheck(dir: string, timeoutBin: string, autoCommit: boolean): void {
  const env = {
    WIKI_DIR: dir,
    FACTCHECK_TIMEOUT_BIN: timeoutBin,
    HERMES_BIN: "hermes-test-double",
    HERMES_PROFILE: "portable-profile",
    HERMES_SKILL: "portable-skill",
    FACTCHECK_AUTO_COMMIT: autoCommit ? "1" : "0",
    FACTCHECK_MAX_BATCHES_PER_RUN: "20",
  };
  const command = [process.execPath, "run", join(TOOL_ROOT, "tools", "factcheck", "factcheck-trigger.ts"), "--full"];
  run(command, dir, env);
  run(command, dir, env);
}

test("factcheck leaves generated readouts uncommitted by default", () => {
  const { dir, timeoutBin, head } = fixture();
  completeFactcheck(dir, timeoutBin, false);
  expect(run(["git", "rev-parse", "HEAD"], dir)).toBe(head);
  expect(run(["git", "diff", "--cached", "--name-only"], dir)).toBe("");
  const untracked = run(["git", "ls-files", "--others", "--exclude-standard", "readouts"], dir).split("\n");
  expect(untracked.filter(Boolean).length).toBe(2);
});

test("FACTCHECK_AUTO_COMMIT commits only generated readouts", () => {
  const { dir, timeoutBin, head } = fixture();
  write(dir, "operator-change.txt", "staged operator work\n");
  run(["git", "add", "operator-change.txt"], dir);
  completeFactcheck(dir, timeoutBin, true);
  const committedHead = run(["git", "rev-parse", "HEAD"], dir);
  expect(committedHead).not.toBe(head);
  expect(run(["git", "show", "-s", "--format=%s", "HEAD"], dir)).toMatch(/^docs\(factcheck\): record readouts for [a-f0-9]{12}$/);
  const names = run(["git", "show", "--format=", "--name-only", "HEAD"], dir).split("\n").filter(Boolean);
  expect(names.length).toBe(2);
  expect(names.every((name) => /^readouts\/\d{4}-\d{2}-\d{2}-factcheck-/.test(name))).toBe(true);
  expect(readFileSync(join(dir, names[0]), "utf8")).toContain("[[concepts/example]]");
  expect(run(["git", "diff", "--cached", "--name-only"], dir)).toBe("operator-change.txt");
});
